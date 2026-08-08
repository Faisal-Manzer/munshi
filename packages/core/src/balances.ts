/**
 * Balances and card cycles, computed here instead of in Postgres.
 *
 * These are ports of the `account_balances` and `card_cycle_balances` views
 * (migrations 001/003/008). They have to move client-side before any amount
 * becomes ciphertext — a SQL view cannot sum what it cannot read — and moving
 * them also means the numbers no longer need a round trip (docs/E2EE.md §7).
 *
 * Semantics are pinned to the SQL, deliberately, including the parts that look
 * odd: an account with no postings still reports a zero row, and cycle figures
 * count only settled entries.
 */
import type { Account, AccountBalance, CardCycle, Posting, Transaction } from "./types";
import { toISODate } from "./ledger";

export interface LedgerData {
  accounts: Account[];
  transactions: Transaction[];
  postings: Posting[];
}

/** `account_balances`: total, settled (done) and pending per account. */
export function computeBalances(data: LedgerData): Map<string, AccountBalance> {
  const statusOf = new Map(data.transactions.map((t) => [t.id, t.status]));
  const out = new Map<string, AccountBalance>(
    // left join: every account appears, even one that was never posted to
    data.accounts.map((a) => [
      a.id,
      { account_id: a.id, balance_paise: 0, settled_paise: 0, pending_paise: 0 },
    ])
  );
  for (const p of data.postings) {
    const row = out.get(p.account_id);
    if (!row) continue; // posting to an account outside this ledger view
    row.balance_paise += p.amount_paise;
    const status = statusOf.get(p.transaction_id);
    if (status === "done") row.settled_paise += p.amount_paise;
    else if (status === "pending") row.pending_paise += p.amount_paise;
  }
  return out;
}

/**
 * `stmt_cutoff`: the most recent statement date on or before today. A card
 * that bills on the 30th uses the 28th in February — the SQL clamps to the
 * month's last day, and so does this.
 */
export function statementCutoff(statementDay: number | null, today = new Date()): string {
  if (statementDay === null) return toISODate(today);
  const y = today.getFullYear();
  const m = today.getMonth();
  const lastOfMonth = new Date(y, m + 1, 0).getDate();
  let cand = new Date(y, m, Math.min(statementDay, lastOfMonth));
  if (cand > today) {
    // this month's statement hasn't happened yet — fall back to last month's
    const prevEnd = new Date(y, m, 0); // last day of the previous month
    cand = new Date(
      prevEnd.getFullYear(),
      prevEnd.getMonth(),
      Math.min(statementDay, prevEnd.getDate())
    );
  }
  return toISODate(cand);
}

/** `card_cycle_balances`: billed vs since-cutoff movement, per credit card. */
export function computeCardCycles(data: LedgerData, today = new Date()): Map<string, CardCycle> {
  const byId = new Map(data.accounts.map((a) => [a.id, a]));
  const settledDate = new Map(
    data.transactions.filter((t) => t.status === "done").map((t) => [t.id, t.date])
  );
  const cards = data.accounts.filter((a) => a.subtype === "credit_card");

  const out = new Map<string, CardCycle>();
  for (const card of cards) {
    // a sub-card bills on its parent's statement day unless it sets its own
    const parent = card.parent_id ? byId.get(card.parent_id) : undefined;
    const day = card.statement_day ?? parent?.statement_day ?? null;
    out.set(card.id, {
      account_id: card.id,
      cutoff: statementCutoff(day, today),
      billed_paise: 0,
      payments_since_paise: 0,
      spends_since_paise: 0,
    });
  }

  for (const p of data.postings) {
    const row = out.get(p.account_id);
    if (!row) continue;
    const date = settledDate.get(p.transaction_id);
    if (date === undefined) continue; // pending entries never enter a cycle
    if (date <= row.cutoff) row.billed_paise += p.amount_paise;
    else if (p.amount_paise > 0) row.payments_since_paise += p.amount_paise;
    else if (p.amount_paise < 0) row.spends_since_paise += p.amount_paise;
  }
  return out;
}

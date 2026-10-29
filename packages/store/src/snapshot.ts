/**
 * Reading a whole book, decrypted.
 *
 * There is no server-side aggregate to ask for any more: a view cannot sum an
 * amount it cannot read (docs/E2EE.md §7). So every caller that wants a number
 * pulls the rows and folds them locally. A book is a few hundred rows, which
 * is cheaper than the round trips the old views cost.
 *
 * The browser does this on every load, and an MCP request does it to answer a
 * read tool or to compute the before→after balances a preview shows — same
 * queries, same decryption, so the two can never disagree about what the book
 * says (docs/MCP.md §4).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Account,
  AccountBalance,
  CardCycle,
  LedgerData,
  Posting,
  RecurringTemplate,
  Transaction,
} from "@munshi/core";
import { computeBalances, computeCardCycles } from "@munshi/core";
import {
  decryptAccount,
  decryptPosting,
  decryptTemplate,
  decryptTransaction,
} from "./codec";

/** The columns a transaction row needs; `select("*")` would also drag the migrated plaintext. */
const TXN_COLUMNS =
  "id, ledger_id, date, description, status, tag, notes, created_at, recurring_template_id, reimburse_account_id, reimburse_amount_paise, payload";
const POSTING_COLUMNS = "id, transaction_id, account_id, amount_paise, payload";

/**
 * PostgREST answers at most `max-rows` (1000 on Supabase) per request and says
 * nothing when it stops there. A book past that size would load with legs
 * missing and every balance quietly wrong, so whole-table reads page until a
 * short page comes back. Ordered by id so pages neither overlap nor skip.
 */
const PAGE = 1000;

async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { data: rows, error };
    const got = (data ?? []) as T[];
    rows.push(...got);
    if (got.length < PAGE) return { data: rows, error: null };
  }
}

export interface LedgerSnapshot extends LedgerData {
  templates: RecurringTemplate[];
}

export interface LedgerView extends LedgerSnapshot {
  balances: Map<string, AccountBalance>;
  cycles: Map<string, CardCycle>;
}

/**
 * Fetch and decrypt a book.
 *
 * @param ledgerKey null for a book that has not been encrypted. A book that
 *   *has* been will throw here rather than return half-readable rows — the
 *   caller has no key, so it must not act as if it read anything.
 * @param withTemplates skipped by callers that only need actuals, since the
 *   plan screen is the only place recurring templates matter.
 */
export async function loadLedger(
  supabase: SupabaseClient,
  ledgerId: string,
  ledgerKey: Uint8Array | null,
  { withTemplates = true }: { withTemplates?: boolean } = {}
): Promise<LedgerSnapshot> {
  const [accRes, txnRes, postRes, tplRes] = await Promise.all([
    supabase
      .from("accounts")
      .select("*")
      .eq("ledger_id", ledgerId)
      .order("sort_order")
      .order("created_at"),
    selectAll((from, to) =>
      supabase.from("transactions").select(TXN_COLUMNS).eq("ledger_id", ledgerId).order("id").range(from, to)
    ),
    selectAll((from, to) =>
      supabase.from("postings").select(POSTING_COLUMNS).eq("ledger_id", ledgerId).order("id").range(from, to)
    ),
    withTemplates
      ? supabase.from("recurring_templates").select("*").eq("ledger_id", ledgerId)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const failure = accRes.error ?? txnRes.error ?? postRes.error ?? tplRes.error;
  if (failure) throw new Error(failure.message);

  return {
    accounts: (accRes.data as Account[]).map((a) => decryptAccount(ledgerKey, a)),
    transactions: (txnRes.data as unknown as Transaction[]).map((t) =>
      decryptTransaction(ledgerKey, t)
    ),
    postings: (postRes.data as unknown as Posting[]).map((p) => decryptPosting(ledgerKey, p)),
    templates: ((tplRes.data ?? []) as RecurringTemplate[]).map((t) =>
      decryptTemplate(ledgerKey, t)
    ),
  };
}

/** A snapshot plus the numbers derived from it. */
export function deriveView(snapshot: LedgerSnapshot, today = new Date()): LedgerView {
  return {
    ...snapshot,
    balances: computeBalances(snapshot),
    cycles: computeCardCycles(snapshot, today),
  };
}

/**
 * A fingerprint of the state a preview was computed from.
 *
 * A proposal carries this so `commit_proposal` can refuse when the book moved
 * underneath it — another device posting an entry between preview and approval
 * would otherwise make the approved before→after balances a lie
 * (docs/MCP.md §2, `STALE_PROPOSAL`).
 *
 * Only the accounts an operation touches are fingerprinted: an unrelated entry
 * elsewhere in the book does not invalidate an approval, and demanding that it
 * did would make every proposal stale on a busy day.
 */
export function balanceFingerprint(
  balances: Map<string, AccountBalance>,
  accountIds: Iterable<string>
): string {
  const parts: string[] = [];
  for (const id of [...accountIds].sort()) {
    const b = balances.get(id);
    parts.push(`${id}:${b?.balance_paise ?? 0}:${b?.pending_paise ?? 0}`);
  }
  return parts.join("|");
}

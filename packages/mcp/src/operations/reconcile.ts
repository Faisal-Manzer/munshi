/**
 * Reconciliation as an event, not a lingering comparison.
 *
 * The book says one number, the bank app says another; the gap is closed with
 * a balanced adjustment and the real-world figure is stamped with a date. No
 * stale snapshot is left behind to drift as new spends are logged — the same
 * decision the UI makes in `reconcile-modal.tsx`, and this mirrors it field
 * for field so the two can never mean different things (docs/MCP.md §4.4).
 */
import {
  accountCreateOp,
  accountUpdateOp,
  computeBalances,
  displayBalance,
  formatPaise,
  subtreeBalance,
  type Account,
  type LedgerOp,
} from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { McpError } from "../errors";
import { buildPreview } from "../preview";
import { uuid, type MintId, type Operation } from "./types";

export interface ReconcileInput {
  ledgerId: string;
  accountId: string;
  /** What the real world says, entered positive — a liability means "owed". */
  realBalancePaise: number;
  /** Which way a person's debt runs. Required for a receivable, ignored otherwise. */
  owesMe?: boolean;
  /** False records the real figure without closing the gap. */
  applyAdjustment?: boolean;
  today: string;
  nowISO: string;
}

const ADJUSTMENTS = "Adjustments";

/** Banks and cards reconcile with their children: the bank app shows one pot. */
function bookBalance(snapshot: LedgerSnapshot, account: Account): number {
  const balances = computeBalances(snapshot);
  return ["bank", "credit_card"].includes(account.subtype)
    ? subtreeBalance(snapshot.accounts, balances, account.id)
    : (balances.get(account.id)?.balance_paise ?? 0);
}

export function proposeReconcile(
  snapshot: LedgerSnapshot,
  input: ReconcileInput,
  mint: MintId = uuid
): Operation {
  const account = snapshot.accounts.find((a) => a.id === input.accountId);
  if (!account) throw new McpError("NOT_FOUND", `No account ${input.accountId} in this book.`);

  const isLiability = account.kind === "liability";
  const isPerson = account.subtype === "receivable";
  if (isPerson && input.owesMe === undefined) {
    throw new McpError(
      "NOT_FOUND",
      `A person's balance can run either way. Say whether ${account.name} owes you or you owe them.`
    );
  }

  const typed = Math.abs(input.realBalancePaise);
  // target is in ledger sign: liabilities store what is owed as a credit
  const target = isLiability ? -typed : isPerson ? (input.owesMe ? typed : -typed) : input.realBalancePaise;
  const raw = bookBalance(snapshot, account);
  const delta = target - raw;

  const ops: LedgerOp[] = [];
  const warnings: string[] = [];
  const apply = input.applyAdjustment ?? true;

  if (delta !== 0 && apply) {
    let adjustment = snapshot.accounts.find(
      (a) => a.kind === "expense" && a.name.toLowerCase() === ADJUSTMENTS.toLowerCase()
    );
    if (!adjustment) {
      const draft = {
        id: mint(),
        ledger_id: input.ledgerId,
        name: ADJUSTMENTS,
        kind: "expense" as const,
        subtype: "general_expense" as const,
        parent_id: null,
        statement_day: null,
        due_day: null,
        credit_limit_paise: null,
        person_name: null,
        reported_balance_paise: null,
        reported_at: null,
        sort_order: 0,
        archived: false,
        is_liquid: false,
      };
      ops.push(accountCreateOp(draft));
      adjustment = draft as Account;
    }
    ops.push({
      kind: "entry.create",
      ledgerId: input.ledgerId,
      txn: { date: input.today, description: `Reconcile — ${account.name}`, status: "done" },
      postings: [
        { account_id: account.id, amount_paise: delta },
        { account_id: adjustment.id, amount_paise: -delta },
      ],
    });
  }

  if (delta !== 0 && !apply) {
    warnings.push(
      `The ${formatPaise(Math.abs(displayBalance(account, delta)))} gap is being recorded, not closed. ` +
        `The book will still disagree with the real balance.`
    );
  }

  ops.push(
    accountUpdateOp(account, {
      reported_balance_paise: target,
      reported_at: input.nowISO,
    })
  );

  const book = displayBalance(account, raw);
  const real = displayBalance(account, target);
  const gap = real - book;

  const explanation =
    delta === 0
      ? `The book already matches. Nothing is posted; only the check is recorded.`
      : gap < 0
        ? `The book is ${formatPaise(Math.abs(gap))} higher than ${account.name}, so that much was ` +
          `spent and never logged. It goes to ${ADJUSTMENTS}.`
        : `${account.name} holds ${formatPaise(Math.abs(gap))} more than the book knows about. ` +
          `It comes in through ${ADJUSTMENTS}.`;

  const last = account.reported_at
    ? `Last reconciled ${account.reported_at.slice(0, 10)}`
    : "Never reconciled before";

  return {
    ops,
    summary: `Reconcile ${account.name} to ${formatPaise(real)}`,
    preview: buildPreview(snapshot, ops, {
      title: `RECONCILE — ${account.name}`,
      explanation: `${explanation} ${last}.`,
      sections: [
        {
          heading: ["bank", "credit_card"].includes(account.subtype)
            ? "Book (including sub-accounts) vs real"
            : "Book vs real",
          rows: [
            ["book", formatPaise(book)],
            ["you say", formatPaise(real)],
            ["gap", formatPaise(gap)],
          ],
        },
      ],
      warnings,
    }),
  };
}

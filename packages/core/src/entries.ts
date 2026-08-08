/**
 * The one mutation API. Every caller — web UI, mobile capture, MCP tools, the
 * in-app AI — writes money through these functions, so the double-entry rules
 * live in exactly one place (Vision "what this means for near-term design" §3).
 *
 * Each function is split in two: a pure builder that turns intent into a
 * balanced op, and a thin call that hands the op to a `LedgerStore`. The
 * builders are what a preview diff renders, and what an encrypted oplog will
 * carry once E2EE lands — no storage knowledge required to produce them.
 */
import type {
  AccountSpec,
  EntryCreateOp,
  EntryRewriteOp,
  LedgerStore,
  PostingDraft,
  TransactionDraft,
} from "./store";

export interface EntryInput {
  ledgerId: string; // which book this entry is written in
  date: string;
  description: string;
  status: "pending" | "done";
  fromAccountId: string; // credited: money/credit leaves here
  toAccountId: string;   // debited: expense, transfer target, loan, person
  amountPaise: number;
  reimburseAccountId?: string | null; // person expected to pay part back
  reimbursePaise?: number | null;     // must be < amountPaise
  recurringTemplateId?: string | null;
  tag?: string | null;
  notes?: string | null;
}

/** The legs of an entry: from is credited, to is debited, person takes a cut. */
export function buildPostings(e: Omit<EntryInput, "ledgerId">): PostingDraft[] {
  const reimburse =
    e.reimburseAccountId && e.reimbursePaise && e.reimbursePaise > 0
      ? Math.min(e.reimbursePaise, e.amountPaise)
      : 0;
  const rows: PostingDraft[] = [
    { account_id: e.fromAccountId, amount_paise: -e.amountPaise },
  ];
  const ownShare = e.amountPaise - reimburse;
  if (ownShare > 0) {
    rows.push({ account_id: e.toAccountId, amount_paise: ownShare });
  }
  if (reimburse > 0 && e.reimburseAccountId) {
    rows.push({ account_id: e.reimburseAccountId, amount_paise: reimburse });
  }
  return rows;
}

function txnDraft(e: Omit<EntryInput, "ledgerId">): TransactionDraft {
  return {
    date: e.date,
    description: e.description,
    status: e.status,
    tag: e.tag ?? null,
    notes: e.notes ?? null,
    recurringTemplateId: e.recurringTemplateId ?? null,
    reimburseAccountId: e.reimburseAccountId ?? null,
    reimbursePaise: e.reimbursePaise ?? null,
  };
}

export function entryCreateOp(e: EntryInput): EntryCreateOp {
  return {
    kind: "entry.create",
    ledgerId: e.ledgerId,
    txn: txnDraft(e),
    postings: buildPostings(e),
  };
}

export function entryRewriteOp(
  transactionId: string,
  e: Omit<EntryInput, "ledgerId"> // a rewrite never moves an entry between books
): EntryRewriteOp {
  return {
    kind: "entry.rewrite",
    transactionId,
    txn: txnDraft(e),
    postings: buildPostings(e),
  };
}

export function createEntry(store: LedgerStore, e: EntryInput): Promise<string> {
  return store.apply(entryCreateOp(e));
}

export function rewriteEntry(
  store: LedgerStore,
  transactionId: string,
  e: Omit<EntryInput, "ledgerId">
): Promise<string> {
  return store.apply(entryRewriteOp(transactionId, e));
}

const OPENING_BALANCES: Omit<AccountSpec, "ledgerId"> = {
  name: "Opening balances",
  kind: "equity",
  subtype: "opening_balance",
};

/**
 * Post a balanced equity adjustment that moves `accountId` to a target
 * balance: used for loan outstanding and opening corrections. `deltaPaise`
 * is the signed change to the account's ledger balance.
 */
export async function postEquityAdjustment(
  store: LedgerStore,
  ledgerId: string,
  accountId: string,
  deltaPaise: number,
  description: string,
  date: string
): Promise<string | null> {
  if (deltaPaise === 0) return null;
  const equity = await store.ensureAccount(
    { ledgerId, ...OPENING_BALANCES },
    "subtype"
  );
  return store.apply({
    kind: "entry.create",
    ledgerId,
    txn: { date, description, status: "done" },
    postings: [
      { account_id: accountId, amount_paise: deltaPaise },
      { account_id: equity.id, amount_paise: -deltaPaise },
    ],
  });
}

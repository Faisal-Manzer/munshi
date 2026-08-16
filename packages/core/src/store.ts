/**
 * The storage boundary.
 *
 * Everything above this interface is pure TypeScript that runs anywhere —
 * browser, React Native, an MCP server, a Worker. Everything below it is a
 * driver: Supabase today, a local SQLite replica + encrypted oplog once E2EE
 * lands (docs/E2EE.md §4).
 *
 * The unit of work is a whole financial operation, never a bare field write.
 * A driver receives an already-balanced set of postings and must persist the
 * transaction and its postings atomically — that is what keeps double-entry
 * invariants intact through sync merges, and what an encrypted op will carry
 * verbatim.
 */
import type {
  Account,
  AccountKind,
  AccountSubtype,
  RecurringTemplate,
  Transaction,
  TxnStatus,
} from "./types";

/** One leg of an entry. Debits are positive, credits negative; legs sum to 0. */
export interface PostingDraft {
  account_id: string;
  amount_paise: number;
}

/** The transaction fields an op carries, independent of storage shape. */
export interface TransactionDraft {
  date: string; // yyyy-mm-dd
  description: string;
  status: TxnStatus;
  tag?: string | null;
  notes?: string | null;
  recurringTemplateId?: string | null;
  reimburseAccountId?: string | null;
  reimbursePaise?: number | null;
}

/** Create an entry: one transaction plus its balanced postings. */
export interface EntryCreateOp {
  kind: "entry.create";
  ledgerId: string;
  txn: TransactionDraft;
  postings: PostingDraft[];
}

/** Rewrite an entry in place. Postings are replaced wholesale, never patched. */
export interface EntryRewriteOp {
  kind: "entry.rewrite";
  transactionId: string;
  txn: TransactionDraft;
  postings: PostingDraft[];
}

/** The two ops that write postings, and the only ones `apply` accepts. */
export type EntryOp = EntryCreateOp | EntryRewriteOp;

/** Edit a transaction's own fields, leaving its legs alone. */
export interface EntryPatchOp {
  kind: "entry.patch";
  current: Transaction;
  patch: Partial<Transaction>;
}

/** Delete a transaction and, by cascade, its postings. */
export interface EntryDeleteOp {
  kind: "entry.delete";
  transactionId: string;
}

/**
 * Ops that create a row carry its id, minted by the caller.
 *
 * Two reasons, both load-bearing: an encrypted payload's AAD binds to the row
 * id, so the id must exist before the ciphertext does; and a batch that
 * creates an account and then posts against it needs to name that account
 * before any of it has been written.
 */
export interface AccountCreateOp {
  kind: "account.create";
  account: NewAccount & { id: string };
}

export interface AccountUpdateOp {
  kind: "account.update";
  current: Account;
  patch: Partial<Account>;
}

export interface TemplateCreateOp {
  kind: "template.create";
  template: NewTemplate & { id: string };
}

export interface TemplateUpdateOp {
  kind: "template.update";
  current: RecurringTemplate;
  patch: Partial<RecurringTemplate>;
}

/**
 * Every write the product can perform, as data.
 *
 * A financial operation is rarely one row: a loan is an account plus a
 * disbursal entry plus a repayment template; a reconcile is an adjustment
 * entry plus a reported-balance stamp. Modelling those as a list of ops is
 * what lets them be previewed as a unit, approved once, and applied
 * atomically — and it is the form an encrypted oplog carries (docs/E2EE.md
 * §4). The MCP server's proposals are literally `LedgerOp[]` (docs/MCP.md §2).
 */
export type LedgerOp =
  | EntryOp
  | EntryPatchOp
  | EntryDeleteOp
  | AccountCreateOp
  | AccountUpdateOp
  | TemplateCreateOp
  | TemplateUpdateOp;

/** What a driver reports back per op: the row's id for creates, null otherwise. */
export interface OpResult {
  kind: LedgerOp["kind"];
  id: string | null;
}

/** Identifies an account that must exist before an op can reference it. */
export interface AccountSpec {
  ledgerId: string;
  name: string;
  kind: AccountKind;
  subtype: AccountSubtype;
}

/** A new account, with every field the create form collects. */
export type NewAccount = Omit<Account, "id" | "user_id" | "payload"> & { id?: string };

/** A new recurring template, minus the columns storage assigns. */
export type NewTemplate = Omit<RecurringTemplate, "id" | "payload"> & { id?: string };

export interface LedgerStore {
  /** Persist one entry op atomically; returns the transaction id. */
  apply(op: EntryOp): Promise<string>;

  /**
   * Persist a whole financial operation: several ops, all or nothing, in the
   * order given. Results line up with the input.
   *
   * This is the write path for anything that spans more than one row — and
   * the only one the MCP server uses, because a proposal the user approved as
   * one thing must not land as half of one.
   */
  applyAll(ops: LedgerOp[]): Promise<OpResult[]>;

  /**
   * Everything below is a mutation that used to be written straight to
   * Postgres from a component. They live here because an encrypted book has
   * no readable columns to write to — a driver has to re-seal the row, and it
   * can only do that if it is the one performing the write.
   *
   * Patches take the current row as well as the change: re-sealing a payload
   * needs every field, not only the edited one.
   */
  createAccount(account: NewAccount): Promise<Account>;
  updateAccount(current: Account, patch: Partial<Account>): Promise<void>;

  createTemplate(template: NewTemplate): Promise<string>;
  updateTemplate(current: RecurringTemplate, patch: Partial<RecurringTemplate>): Promise<void>;

  patchTransaction(current: Transaction, patch: Partial<Transaction>): Promise<void>;
  deleteTransaction(transactionId: string): Promise<void>;
  /**
   * Fetch the ledger's account matching `subtype` (or `name` for the
   * catch-alls that have no subtype of their own), creating it if absent.
   * Used by adjustments and opening balances, which conjure their own
   * counter-account.
   */
  ensureAccount(spec: AccountSpec, matchBy: "subtype" | "name"): Promise<Account>;
}

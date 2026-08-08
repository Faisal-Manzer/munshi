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

export type LedgerOp = EntryCreateOp | EntryRewriteOp;

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
  /** Persist one whole operation atomically; returns the transaction id. */
  apply(op: LedgerOp): Promise<string>;

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

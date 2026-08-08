/**
 * Row ⇄ ciphertext. The single place that decides what the server may read.
 *
 * Each table splits in two: structural columns that stay readable because sync
 * needs to address and order rows, and a `payload` envelope holding every
 * value. Adding a field to a table means deciding, here, which side it lands
 * on — which is the point of keeping the split in one file rather than spread
 * across queries.
 *
 * The AAD binds each envelope to its own row id and table, so a payload lifted
 * from one row and pasted into another fails to decrypt rather than silently
 * moving an amount.
 */
import { decrypt, encrypt } from "@munshi/crypto";
import type { Account, Posting, RecurringTemplate, Transaction } from "@munshi/core";

/** Values that leave the device only as ciphertext. */
interface AccountPayload {
  name: string;
  person_name: string | null;
  credit_limit_paise: number | null;
  reported_balance_paise: number | null;
}
interface TransactionPayload {
  description: string;
  notes: string | null;
  tag: string | null;
  reimburse_amount_paise: number | null;
}
interface PostingPayload {
  amount_paise: number;
}
interface TemplatePayload {
  name: string;
  amount_paise: number;
  reimburse_amount_paise: number | null;
  notes: string | null;
}

type Table = "accounts" | "transactions" | "postings" | "recurring_templates";

function aad(table: Table, rowId: string): string {
  return `munshi/row/${table}/${rowId}`;
}

function seal<T>(key: Uint8Array, table: Table, rowId: string, payload: T): string {
  return encrypt(key, new TextEncoder().encode(JSON.stringify(payload)), aad(table, rowId));
}

function open<T>(key: Uint8Array, table: Table, rowId: string, payload: string): T {
  return JSON.parse(new TextDecoder().decode(decrypt(key, payload, aad(table, rowId)))) as T;
}

// ---- encrypt (client → server) --------------------------------------------

/**
 * Split a row for storage. Returns the columns to write: values nulled out,
 * payload filled in. The plaintext columns are explicitly set to null rather
 * than omitted, so migrating an existing row actually clears it.
 */
export function encryptAccount(key: Uint8Array, id: string, a: Partial<Account>) {
  const payload: AccountPayload = {
    name: a.name ?? "",
    person_name: a.person_name ?? null,
    credit_limit_paise: a.credit_limit_paise ?? null,
    reported_balance_paise: a.reported_balance_paise ?? null,
  };
  return {
    name: null,
    person_name: null,
    credit_limit_paise: null,
    reported_balance_paise: null,
    payload: seal(key, "accounts", id, payload),
  };
}

export function encryptTransaction(key: Uint8Array, id: string, t: Partial<Transaction>) {
  const payload: TransactionPayload = {
    description: t.description ?? "",
    notes: t.notes ?? null,
    tag: t.tag ?? null,
    reimburse_amount_paise: t.reimburse_amount_paise ?? null,
  };
  return {
    description: null,
    notes: null,
    tag: null,
    reimburse_amount_paise: null,
    payload: seal(key, "transactions", id, payload),
  };
}

export function encryptPosting(key: Uint8Array, id: string, amountPaise: number) {
  const payload: PostingPayload = { amount_paise: amountPaise };
  return { amount_paise: null, payload: seal(key, "postings", id, payload) };
}

export function encryptTemplate(key: Uint8Array, id: string, t: Partial<RecurringTemplate>) {
  const payload: TemplatePayload = {
    name: t.name ?? "",
    amount_paise: t.amount_paise ?? 0,
    reimburse_amount_paise: t.reimburse_amount_paise ?? null,
    notes: t.notes ?? null,
  };
  return {
    name: null,
    amount_paise: null,
    reimburse_amount_paise: null,
    notes: null,
    payload: seal(key, "recurring_templates", id, payload),
  };
}

// ---- decrypt (server → client) --------------------------------------------

/**
 * Rehydrate a row. A row with no payload is pre-migration plaintext and passes
 * through untouched — that is what lets an encrypted and an un-encrypted
 * ledger coexist while a book is being migrated.
 */
function hydrate<T extends { payload?: string | null }, P>(
  key: Uint8Array | null,
  table: Table,
  row: T,
  id: string
): T & P {
  if (!row.payload) return row as T & P;
  if (!key) throw new Error("This book is encrypted — unlock it to read entries.");
  const values = open<P>(key, table, id, row.payload);
  return { ...row, ...values };
}

export function decryptAccount(key: Uint8Array | null, row: Account): Account {
  return hydrate<Account, AccountPayload>(key, "accounts", row, row.id);
}

export function decryptTransaction(key: Uint8Array | null, row: Transaction): Transaction {
  return hydrate<Transaction, TransactionPayload>(key, "transactions", row, row.id);
}

export function decryptPosting(key: Uint8Array | null, row: Posting): Posting {
  return hydrate<Posting, PostingPayload>(key, "postings", row, row.id);
}

export function decryptTemplate(key: Uint8Array | null, row: RecurringTemplate): RecurringTemplate {
  return hydrate<RecurringTemplate, TemplatePayload>(key, "recurring_templates", row, row.id);
}

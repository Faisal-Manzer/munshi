/**
 * One-time migration of a book from plaintext rows to encrypted payloads.
 *
 * Runs entirely in the browser, because that is the only place the ledger key
 * exists. Every row is read, sealed, and written back with its value columns
 * nulled; the book is marked `encrypted_at` only after every row has landed.
 *
 * Ordering matters: if this is interrupted, some rows are encrypted and some
 * are not, and the book is still readable — the codec passes payload-less rows
 * through untouched. Re-running finishes the job, since already-encrypted rows
 * are skipped by the `payload is null` filter.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Account, Posting, RecurringTemplate, Transaction } from "@munshi/core";
import {
  encryptAccount,
  encryptPosting,
  encryptTemplate,
  encryptTransaction,
} from "@/lib/e2ee/codec";

export interface EncryptProgress {
  step: string;
  done: number;
  total: number;
}

export interface EncryptResult {
  accounts: number;
  transactions: number;
  postings: number;
  templates: number;
}

async function pending<T>(
  supabase: SupabaseClient,
  table: string,
  ledgerId: string,
  columns: string
): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq("ledger_id", ledgerId)
    .is("payload", null);
  if (error) throw error;
  return (data ?? []) as T[];
}

export async function encryptBook(
  supabase: SupabaseClient,
  ledgerId: string,
  key: Uint8Array,
  onProgress?: (p: EncryptProgress) => void
): Promise<EncryptResult> {
  const accounts = await pending<Account>(
    supabase, "accounts", ledgerId,
    "id, name, person_name, credit_limit_paise, reported_balance_paise"
  );
  const transactions = await pending<Transaction>(
    supabase, "transactions", ledgerId,
    "id, description, notes, tag, reimburse_amount_paise"
  );
  const postings = await pending<Posting>(
    supabase, "postings", ledgerId, "id, amount_paise"
  );
  const templates = await pending<RecurringTemplate>(
    supabase, "recurring_templates", ledgerId,
    "id, name, amount_paise, reimburse_amount_paise, notes"
  );

  const total = accounts.length + transactions.length + postings.length + templates.length;
  let done = 0;
  const tick = (step: string) => {
    done++;
    onProgress?.({ step, done, total });
  };

  // Postings before transactions, and both before the ledger flag: every
  // intermediate state has to be one a reader can still make sense of.
  for (const p of postings) {
    const { error } = await supabase
      .from("postings")
      .update(encryptPosting(key, p.id, p.amount_paise))
      .eq("id", p.id);
    if (error) throw error;
    tick("entries");
  }
  for (const t of transactions) {
    const { error } = await supabase
      .from("transactions")
      .update(encryptTransaction(key, t.id, t))
      .eq("id", t.id);
    if (error) throw error;
    tick("entries");
  }
  for (const a of accounts) {
    const { error } = await supabase
      .from("accounts")
      .update(encryptAccount(key, a.id, a))
      .eq("id", a.id);
    if (error) throw error;
    tick("accounts");
  }
  for (const t of templates) {
    const { error } = await supabase
      .from("recurring_templates")
      .update(encryptTemplate(key, t.id, t))
      .eq("id", t.id);
    if (error) throw error;
    tick("recurring");
  }

  const { error } = await supabase
    .from("ledgers")
    .update({ encrypted_at: new Date().toISOString() })
    .eq("id", ledgerId);
  if (error) throw error;

  return {
    accounts: accounts.length,
    transactions: transactions.length,
    postings: postings.length,
    templates: templates.length,
  };
}

/** How much of this book is still readable by the server. */
export async function encryptionStatus(
  supabase: SupabaseClient,
  ledgerId: string
): Promise<{ plaintextRows: number; encryptedAt: string | null }> {
  const counts = await Promise.all(
    ["accounts", "transactions", "postings", "recurring_templates"].map(async (table) => {
      const { count, error } = await supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("ledger_id", ledgerId)
        .is("payload", null);
      if (error) throw error;
      return count ?? 0;
    })
  );
  const { data } = await supabase
    .from("ledgers")
    .select("encrypted_at")
    .eq("id", ledgerId)
    .maybeSingle();
  return {
    plaintextRows: counts.reduce((a, b) => a + b, 0),
    encryptedAt: (data?.encrypted_at as string | null) ?? null,
  };
}

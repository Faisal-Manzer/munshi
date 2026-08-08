/**
 * Supabase driver for `LedgerStore` — the only place in the app that knows how
 * an operation becomes rows. Swapping this for a local SQLite replica plus an
 * encrypted oplog (docs/E2EE.md §4) is meant to leave every caller untouched.
 *
 * Postgres has no client-side transaction here, so atomicity is enforced the
 * way it already was: if the postings insert fails, the half-written
 * transaction is deleted before the error propagates.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Account,
  AccountSpec,
  LedgerOp,
  LedgerStore,
  NewAccount,
  NewTemplate,
  PostingDraft,
  RecurringTemplate,
  Transaction,
  TransactionDraft,
} from "@munshi/core";
import {
  encryptAccount,
  encryptPosting,
  encryptTemplate,
  encryptTransaction,
} from "@/lib/e2ee/codec";

function txnRow(txn: TransactionDraft) {
  return {
    date: txn.date,
    description: txn.description,
    status: txn.status,
    tag: txn.tag ?? null,
    notes: txn.notes ?? null,
    reimburse_account_id: txn.reimburseAccountId ?? null,
    reimburse_amount_paise: txn.reimbursePaise ?? null,
  };
}

function postingRows(
  transactionId: string,
  postings: PostingDraft[],
  ledgerKey: Uint8Array | null
) {
  return postings.map((p) => {
    if (!ledgerKey) return { ...p, transaction_id: transactionId };
    const id = crypto.randomUUID();
    return {
      id,
      transaction_id: transactionId,
      account_id: p.account_id,
      ...encryptPosting(ledgerKey, id, p.amount_paise),
    };
  });
}

/**
 * @param ledgerKey  the active book's key, or null for a book that has not
 *                   been encrypted yet. Rows are written in whichever format
 *                   the book is already in — there is no half-migrated state.
 */
export function createSupabaseStore(
  supabase: SupabaseClient,
  ledgerKey: Uint8Array | null = null
): LedgerStore {
  // ids are minted client-side when encrypting: the payload's AAD binds to the
  // row id, so the id has to exist before the ciphertext does
  const newId = () => crypto.randomUUID();
  return {
    async apply(op: LedgerOp): Promise<string> {
      if (op.kind === "entry.create") {
        const id = ledgerKey ? newId() : undefined;
        const { data: txn, error } = await supabase
          .from("transactions")
          .insert({
            ...(id ? { id } : {}),
            ...txnRow(op.txn),
            ...(ledgerKey ? encryptTransaction(ledgerKey, id!, txnRow(op.txn)) : {}),
            ledger_id: op.ledgerId,
            recurring_template_id: op.txn.recurringTemplateId ?? null,
          })
          .select("id")
          .single();
        if (error) throw error;
        const { error: pe } = await supabase
          .from("postings")
          .insert(postingRows(txn.id, op.postings, ledgerKey));
        if (pe) {
          await supabase.from("transactions").delete().eq("id", txn.id);
          throw pe;
        }
        return txn.id as string;
      }

      // rewrite: the txn keeps its id, the legs are replaced wholesale —
      // delete-all leaves the transaction balanced (sum 0) at every instant
      const { error } = await supabase
        .from("transactions")
        .update({
          ...txnRow(op.txn),
          ...(ledgerKey ? encryptTransaction(ledgerKey, op.transactionId, txnRow(op.txn)) : {}),
        })
        .eq("id", op.transactionId);
      if (error) throw error;
      const { error: de } = await supabase
        .from("postings")
        .delete()
        .eq("transaction_id", op.transactionId);
      if (de) throw de;
      const { error: pe } = await supabase
        .from("postings")
        .insert(postingRows(op.transactionId, op.postings, ledgerKey));
      if (pe) throw pe;
      return op.transactionId;
    },

    async createAccount(account: NewAccount): Promise<Account> {
      const id = account.id ?? (ledgerKey ? newId() : undefined);
      const { data, error } = await supabase
        .from("accounts")
        .insert({
          ...(id ? { id } : {}),
          ...account,
          ...(ledgerKey ? encryptAccount(ledgerKey, id!, account) : {}),
        })
        .select()
        .single();
      if (error) throw error;
      // the row that comes back has its value columns blanked when encrypted;
      // hand the caller what it actually asked to store
      return { ...(data as Account), ...account } as Account;
    },

    async updateAccount(current: Account, patch: Partial<Account>): Promise<void> {
      const merged = { ...current, ...patch };
      const { error } = await supabase
        .from("accounts")
        .update({
          ...patch,
          ...(ledgerKey ? encryptAccount(ledgerKey, current.id, merged) : {}),
        })
        .eq("id", current.id);
      if (error) throw error;
    },

    async createTemplate(template: NewTemplate): Promise<string> {
      const id = template.id ?? (ledgerKey ? newId() : undefined);
      const { data, error } = await supabase
        .from("recurring_templates")
        .insert({
          ...(id ? { id } : {}),
          ...template,
          ...(ledgerKey ? encryptTemplate(ledgerKey, id!, template) : {}),
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },

    async updateTemplate(
      current: RecurringTemplate,
      patch: Partial<RecurringTemplate>
    ): Promise<void> {
      const merged = { ...current, ...patch };
      const { error } = await supabase
        .from("recurring_templates")
        .update({
          ...patch,
          ...(ledgerKey ? encryptTemplate(ledgerKey, current.id, merged) : {}),
        })
        .eq("id", current.id);
      if (error) throw error;
    },

    async patchTransaction(current: Transaction, patch: Partial<Transaction>): Promise<void> {
      const merged = { ...current, ...patch };
      const { error } = await supabase
        .from("transactions")
        .update({
          ...patch,
          ...(ledgerKey ? encryptTransaction(ledgerKey, current.id, merged) : {}),
        })
        .eq("id", current.id);
      if (error) throw error;
    },

    async deleteTransaction(transactionId: string): Promise<void> {
      const { error } = await supabase.from("transactions").delete().eq("id", transactionId);
      if (error) throw error;
    },

    async ensureAccount(spec: AccountSpec, matchBy): Promise<Account> {
      const query = supabase
        .from("accounts")
        .select("*")
        .eq("ledger_id", spec.ledgerId);
      // an encrypted book has no readable name to match on, so the catch-all
      // accounts are found by kind+subtype there
      const { data: found } =
        matchBy === "subtype" || ledgerKey
          ? await query.eq("subtype", spec.subtype).limit(1).maybeSingle()
          : await query.eq("kind", spec.kind).ilike("name", spec.name).limit(1).maybeSingle();
      if (found) return found as Account;

      const id = ledgerKey ? newId() : undefined;
      const { data, error } = await supabase
        .from("accounts")
        .insert({
          ...(id ? { id } : {}),
          ledger_id: spec.ledgerId,
          name: spec.name,
          kind: spec.kind,
          subtype: spec.subtype,
          ...(ledgerKey ? encryptAccount(ledgerKey, id!, { name: spec.name }) : {}),
        })
        .select()
        .single();
      if (error) throw error;
      // hand back the plaintext the caller asked for, not the blanked row
      return { ...(data as Account), name: spec.name };
    },
  };
}

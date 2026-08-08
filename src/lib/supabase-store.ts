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
  PostingDraft,
  TransactionDraft,
} from "@munshi/core";

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

function postingRows(transactionId: string, postings: PostingDraft[]) {
  return postings.map((p) => ({ ...p, transaction_id: transactionId }));
}

export function createSupabaseStore(supabase: SupabaseClient): LedgerStore {
  return {
    async apply(op: LedgerOp): Promise<string> {
      if (op.kind === "entry.create") {
        const { data: txn, error } = await supabase
          .from("transactions")
          .insert({
            ...txnRow(op.txn),
            ledger_id: op.ledgerId,
            recurring_template_id: op.txn.recurringTemplateId ?? null,
          })
          .select()
          .single();
        if (error) throw error;
        const { error: pe } = await supabase
          .from("postings")
          .insert(postingRows(txn.id, op.postings));
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
        .update(txnRow(op.txn))
        .eq("id", op.transactionId);
      if (error) throw error;
      const { error: de } = await supabase
        .from("postings")
        .delete()
        .eq("transaction_id", op.transactionId);
      if (de) throw de;
      const { error: pe } = await supabase
        .from("postings")
        .insert(postingRows(op.transactionId, op.postings));
      if (pe) throw pe;
      return op.transactionId;
    },

    async ensureAccount(spec: AccountSpec, matchBy): Promise<Account> {
      const query = supabase
        .from("accounts")
        .select("*")
        .eq("ledger_id", spec.ledgerId);
      const { data: found } =
        matchBy === "subtype"
          ? await query.eq("subtype", spec.subtype).limit(1).maybeSingle()
          : await query.eq("kind", spec.kind).ilike("name", spec.name).limit(1).maybeSingle();
      if (found) return found as Account;

      const { data, error } = await supabase
        .from("accounts")
        .insert({
          ledger_id: spec.ledgerId,
          name: spec.name,
          kind: spec.kind,
          subtype: spec.subtype,
        })
        .select()
        .single();
      if (error) throw error;
      return data as Account;
    },
  };
}

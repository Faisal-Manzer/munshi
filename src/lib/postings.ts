import type { SupabaseClient } from "@supabase/supabase-js";

export interface EntryInput {
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

export function buildPostings(
  txnId: string,
  e: EntryInput
): { transaction_id: string; account_id: string; amount_paise: number }[] {
  const reimburse =
    e.reimburseAccountId && e.reimbursePaise && e.reimbursePaise > 0
      ? Math.min(e.reimbursePaise, e.amountPaise)
      : 0;
  const rows = [
    { transaction_id: txnId, account_id: e.fromAccountId, amount_paise: -e.amountPaise },
  ];
  const ownShare = e.amountPaise - reimburse;
  if (ownShare > 0) {
    rows.push({ transaction_id: txnId, account_id: e.toAccountId, amount_paise: ownShare });
  }
  if (reimburse > 0 && e.reimburseAccountId) {
    rows.push({ transaction_id: txnId, account_id: e.reimburseAccountId, amount_paise: reimburse });
  }
  return rows;
}

export async function createEntry(supabase: SupabaseClient, e: EntryInput) {
  const { data: txn, error } = await supabase
    .from("transactions")
    .insert({
      date: e.date,
      description: e.description,
      status: e.status,
      reimburse_account_id: e.reimburseAccountId ?? null,
      reimburse_amount_paise: e.reimbursePaise ?? null,
      recurring_template_id: e.recurringTemplateId ?? null,
      tag: e.tag ?? null,
      notes: e.notes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  const { error: pe } = await supabase
    .from("postings")
    .insert(buildPostings(txn.id, e));
  if (pe) {
    await supabase.from("transactions").delete().eq("id", txn.id);
    throw pe;
  }
  return txn;
}

export async function rewriteEntry(
  supabase: SupabaseClient,
  txnId: string,
  e: EntryInput
) {
  const { error } = await supabase
    .from("transactions")
    .update({
      date: e.date,
      description: e.description,
      status: e.status,
      reimburse_account_id: e.reimburseAccountId ?? null,
      reimburse_amount_paise: e.reimbursePaise ?? null,
      tag: e.tag ?? null,
      notes: e.notes ?? null,
    })
    .eq("id", txnId);
  if (error) throw error;
  // delete-all leaves the txn balanced (sum 0); re-insert is one balanced batch
  const { error: de } = await supabase.from("postings").delete().eq("transaction_id", txnId);
  if (de) throw de;
  const { error: pe } = await supabase.from("postings").insert(buildPostings(txnId, e));
  if (pe) throw pe;
}

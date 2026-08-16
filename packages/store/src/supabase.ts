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
  EntryOp,
  LedgerOp,
  LedgerStore,
  NewAccount,
  NewTemplate,
  OpResult,
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
} from "@munshi/store";

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

  /** The subset of `current` covering the keys a patch touched. */
  function revertOf<T extends object>(current: T, patch: Partial<T>): Partial<T> {
    const back: Partial<T> = {};
    for (const k of Object.keys(patch) as (keyof T)[]) back[k] = current[k];
    return back;
  }

  const store: LedgerStore = {
    async apply(op: EntryOp): Promise<string> {
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

    /**
     * All or nothing, without a transaction to lean on.
     *
     * PostgREST gives one statement per request, so a batch is applied step by
     * step and unwound in reverse if any step fails. That undo is real for
     * creates (delete the row) and for patches (write the old values back,
     * which the op carries because re-sealing a payload needs them anyway).
     *
     * It is not real for a delete — nothing can restore a deleted row — so
     * deletes are moved to the end and run only once everything else has
     * landed. A failure can therefore leave writes applied but nothing lost.
     * Results are returned in the caller's original order regardless.
     *
     * The honest limit: a crash between two steps skips the undo entirely.
     * Closing that needs a Postgres function taking the whole sealed batch,
     * which is the next migration (docs/MCP.md §6).
     */
    async applyAll(ops: LedgerOp[]): Promise<OpResult[]> {
      const deletes = ops.filter((o) => o.kind === "entry.delete");
      const ordered = [...ops.filter((o) => o.kind !== "entry.delete"), ...deletes];
      const undo: (() => Promise<void>)[] = [];
      const done = new Map<LedgerOp, OpResult>();

      const dropRow = (table: string, id: string) => async () => {
        await supabase.from(table).delete().eq("id", id);
      };

      try {
        for (const op of ordered) {
          switch (op.kind) {
            case "entry.create":
            case "entry.rewrite": {
              const before =
                op.kind === "entry.rewrite"
                  ? await supabase
                      .from("postings")
                      .select("*")
                      .eq("transaction_id", op.transactionId)
                  : null;
              const id = await store.apply(op);
              if (op.kind === "entry.create") {
                undo.push(dropRow("transactions", id));
              } else if (before?.data) {
                // put the old legs back; the txn row itself is patched, not moved
                const rows = before.data;
                undo.push(async () => {
                  await supabase.from("postings").delete().eq("transaction_id", id);
                  await supabase.from("postings").insert(rows);
                });
              }
              done.set(op, { kind: op.kind, id });
              break;
            }
            case "account.create": {
              const created = await store.createAccount(op.account);
              undo.push(dropRow("accounts", created.id));
              done.set(op, { kind: op.kind, id: created.id });
              break;
            }
            case "account.update": {
              const back = revertOf(op.current, op.patch);
              await store.updateAccount(op.current, op.patch);
              undo.push(async () => {
                await store.updateAccount({ ...op.current, ...op.patch }, back);
              });
              done.set(op, { kind: op.kind, id: op.current.id });
              break;
            }
            case "template.create": {
              const id = await store.createTemplate(op.template);
              undo.push(dropRow("recurring_templates", id));
              done.set(op, { kind: op.kind, id });
              break;
            }
            case "template.update": {
              const back = revertOf(op.current, op.patch);
              await store.updateTemplate(op.current, op.patch);
              undo.push(async () => {
                await store.updateTemplate({ ...op.current, ...op.patch }, back);
              });
              done.set(op, { kind: op.kind, id: op.current.id });
              break;
            }
            case "entry.patch": {
              const back = revertOf(op.current, op.patch);
              await store.patchTransaction(op.current, op.patch);
              undo.push(async () => {
                await store.patchTransaction({ ...op.current, ...op.patch }, back);
              });
              done.set(op, { kind: op.kind, id: op.current.id });
              break;
            }
            case "entry.delete": {
              await store.deleteTransaction(op.transactionId);
              done.set(op, { kind: op.kind, id: op.transactionId });
              break;
            }
          }
        }
      } catch (e) {
        // best effort: an undo that itself fails must not mask the real error
        for (const step of undo.reverse()) {
          try {
            await step();
          } catch {
            /* keep unwinding */
          }
        }
        throw e;
      }

      return ops.map((op) => done.get(op)!);
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

  return store;
}

"use client";

import { useEffect, useState } from "react";
import { useLedger } from "@/lib/use-ledger";
import { Field } from "@/components/field";
import { Modal } from "@/components/modal";
import { createEntry, displayBalance, formatPaise, parseRupees, subtreeBalance, toISODate } from "@munshi/core";
import type { Account } from "@munshi/core";

/**
 * Reconciliation as an event, not a lingering comparison: show the book
 * balance and the real-world number side by side, and close any gap with a
 * balanced adjustment entry. No stale snapshot is left behind to drift as
 * new spends are logged.
 */
export function ReconcileModal({
  account, onDone, onClose,
}: {
  account: Account | null;
  onDone: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { supabase, store, ledgerId, accounts, balances } = useLedger();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // people can swing either way, so the direction is picked, not signed
  const [owesMe, setOwesMe] = useState(true);

  const bookSign = account ? balances.get(account.id)?.balance_paise ?? 0 : 0;
  useEffect(() => {
    setValue("");
    setErr(null);
    setOwesMe(bookSign >= 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  if (!account) return null;

  const isLiability = account.kind === "liability";
  const isPerson = account.subtype === "receivable";
  // banks fold in their envelopes; the bank app shows the whole pot
  const rawBook = ["bank", "credit_card"].includes(account.subtype)
    ? subtreeBalance(accounts, balances, account.id)
    : balances.get(account.id)?.balance_paise ?? 0;
  const book = displayBalance(account, rawBook); // liabilities read positive-owed

  const typed = parseRupees(value);
  // target ledger balance: liabilities store owed as negative; a person is an
  // asset that goes negative when the debt runs the other way
  const target = typed === null
    ? null
    : isLiability
      ? -typed
      : isPerson
        ? (owesMe ? Math.abs(typed) : -Math.abs(typed))
        : typed;
  const delta = target === null ? null : target - rawBook;

  async function postAdjustment(deltaPaise: number) {
    let adj = accounts.find(
      (a) => a.kind === "expense" && a.name.toLowerCase() === "adjustments"
    );
    if (!adj) {
      const { data, error } = await supabase
        .from("accounts")
        .insert({ ledger_id: ledgerId, name: "Adjustments", kind: "expense", subtype: "general_expense" })
        .select()
        .single();
      if (error) throw error;
      adj = data as Account;
    }
    await createEntry(store, {
      ledgerId: ledgerId!,
      date: toISODate(new Date()),
      description: `Reconcile — ${account!.name}`,
      status: "done",
      // book too high → money left unlogged (spend); book too low → money in
      fromAccountId: deltaPaise < 0 ? account!.id : adj.id,
      toAccountId: deltaPaise < 0 ? adj.id : account!.id,
      amountPaise: Math.abs(deltaPaise),
    });
  }

  async function save(withAdjustment: boolean) {
    if (typed === null || target === null || delta === null) return;
    setSaving(true);
    setErr(null);
    try {
      if (withAdjustment && delta !== 0) await postAdjustment(delta);
      await supabase
        .from("accounts")
        .update({ reported_balance_paise: target, reported_at: new Date().toISOString() })
        .eq("id", account!.id);
      await onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setSaving(false);
    }
  }

  const lastRec = account.reported_at
    ? new Date(account.reported_at).toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
      })
    : null;

  return (
    <Modal open title={`Reconcile ${account.name}`}
      subtitle={isPerson
        ? "Agree the number with them, then close the gap"
        : "Match the books to the real-world balance"} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-ink-soft">
            {isLiability ? "Book says you owe"
              : isPerson ? (book >= 0 ? "Book says they owe you" : "Book says you owe them")
              : "Book balance"}
          </span>
          <span className="amount">{formatPaise(isPerson ? Math.abs(book) : book)}</span>
        </div>
        <p className="text-[11px] text-ink-faint -mt-2">
          {lastRec ? `Last reconciled ${lastRec}` : "Never reconciled"}
        </p>
        {isPerson && (
          <div className="flex gap-1 text-xs">
            {([true, false] as const).map((v) => (
              <button key={String(v)} type="button" onClick={() => setOwesMe(v)}
                className={`px-2.5 py-1 border ${owesMe === v
                  ? "border-ledger text-ledger bg-ledger-soft"
                  : "border-rule text-ink-soft hover:text-ink"}`}>
                {v ? "They owe me" : "I owe them"}
              </button>
            ))}
          </div>
        )}
        <Field
          label={isLiability
            ? "Outstanding in the card/loan app (₹)"
            : isPerson
              ? `What ${owesMe ? "they actually owe you" : "you actually owe them"} today (₹)`
              : "Balance in the bank app (₹)"}
          hint={isPerson
            ? "Settle the number with them, then post the gap as an adjustment"
            : undefined}>
          <input value={value} onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save(true)}
            inputMode="decimal" autoFocus placeholder="0"
            className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount" />
        </Field>
        {delta !== null && delta !== 0 && (
          <p className="text-xs text-ink-soft border border-rule bg-paper px-3 py-2">
            {delta < 0
              ? <>Book is <span className="amount amount-inline">{formatPaise(Math.abs(delta))}</span> higher —
                  something {isLiability ? "was over-logged"
                    : isPerson ? "they paid back wasn't logged"
                    : "left this account unlogged"}.</>
              : <>Book is <span className="amount amount-inline">{formatPaise(delta)}</span> lower —
                  something {isLiability ? "swiped wasn't logged"
                    : isPerson ? "you gave them wasn't logged"
                    : "came in unlogged"}.</>}
            {" "}Posting an adjustment entry makes the books match.
          </p>
        )}
        {delta === 0 && typed !== null && (
          <p className="text-xs text-ledger">Books already match — nothing to adjust.</p>
        )}
        {err && <p className="text-sm text-debit">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-sm text-ink-soft px-3 py-1.5 hover:text-ink">
            Cancel
          </button>
          {delta !== null && delta !== 0 && (
            <button onClick={() => save(false)} disabled={saving}
              className="text-sm border border-rule px-3 py-1.5 text-ink-soft hover:text-ink disabled:opacity-60">
              Save without adjusting
            </button>
          )}
          <button onClick={() => save(true)} disabled={saving || typed === null}
            className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90 disabled:opacity-60">
            {saving ? "Saving…" : delta !== null && delta !== 0 ? "Post adjustment & save" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger } from "@/lib/use-ledger";
import { createEntry } from "@/lib/postings";
import { Amount } from "@/components/amount";
import { formatPaise, parseRupees } from "@/lib/money";
import { toISODate } from "@/lib/ledger";
import type { Account, Posting, Transaction } from "@/lib/types";

interface PersonTxn {
  txn: Transaction;
  amountPaise: number; // + they now owe more, - they paid back
}

export default function PeoplePage() {
  const { supabase, accounts, balances, loading, reload } = useLedger();
  const [history, setHistory] = useState<Map<string, PersonTxn[]>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const people = useMemo(
    () => accounts.filter((a) => a.subtype === "receivable" && !a.archived),
    [accounts]
  );
  const banks = useMemo(
    () => accounts.filter((a) => ["bank", "cash"].includes(a.subtype) && !a.archived),
    [accounts]
  );

  const loadHistory = useCallback(async () => {
    if (people.length === 0) return;
    const ids = people.map((p) => p.id);
    const { data, error: e } = await supabase
      .from("postings")
      .select("*, transactions(*)")
      .in("account_id", ids);
    if (e) {
      setError(e.message);
      return;
    }
    const map = new Map<string, PersonTxn[]>();
    for (const p of (data ?? []) as (Posting & { transactions: Transaction })[]) {
      const list = map.get(p.account_id) ?? [];
      list.push({ txn: p.transactions, amountPaise: p.amount_paise });
      map.set(p.account_id, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.txn.date < b.txn.date ? 1 : -1));
    }
    setHistory(map);
  }, [supabase, people]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function recordReceived(person: Account) {
    const owed = balances.get(person.id)?.balance_paise ?? 0;
    const amtStr = prompt(
      `Amount received from ${person.name} (owes ${formatPaise(owed)}):`,
      owed > 0 ? String(owed / 100) : ""
    );
    if (amtStr === null) return;
    const paise = parseRupees(amtStr);
    if (!paise || paise <= 0) return;
    const bank =
      banks.length === 1
        ? banks[0]
        : banks.find(
            (b) =>
              b.name.toLowerCase() ===
              prompt(`Into which account? (${banks.map((b) => b.name).join(" / ")})`, banks[0]?.name)?.toLowerCase()
          );
    if (!bank) return;
    try {
      await createEntry(supabase, {
        date: toISODate(new Date()),
        description: `Received from ${person.name}`,
        status: "done",
        fromAccountId: person.id, // credit receivable
        toAccountId: bank.id, // debit bank
        amountPaise: paise,
      });
      setError(null);
      await Promise.all([reload(), loadHistory()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>;

  const totalOwed = people.reduce(
    (s, p) => s + (balances.get(p.id)?.balance_paise ?? 0),
    0
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <h1 className="text-3xl">People</h1>
        <p className="text-sm text-ink-soft">
          Total owed to you: <Amount paise={totalOwed} className="text-ledger" />
        </p>
      </div>

      {error && <p className="text-sm text-debit">{error}</p>}

      {people.length === 0 && (
        <p className="text-sm text-ink-faint border border-dashed border-rule p-4">
          Add people under Accounts → “Person (owes you)”. Their EMIs on your
          card, shared loans and lent money all collect here.
        </p>
      )}

      <div className="space-y-2">
        {people.map((p) => {
          const bal = balances.get(p.id)?.balance_paise ?? 0;
          const txns = history.get(p.id) ?? [];
          const isOpen = open === p.id;
          return (
            <div key={p.id} className="border border-rule bg-paper-raised">
              <div className="flex items-center gap-3 px-4 py-3">
                <button onClick={() => setOpen(isOpen ? null : p.id)}
                  className="text-left flex-1 min-w-0">
                  <p className="text-sm">{p.name}</p>
                  <p className="text-xs text-ink-faint">
                    {txns.length} entries · click to {isOpen ? "hide" : "show"} ledger
                  </p>
                </button>
                <Amount paise={bal} className={bal > 0 ? "text-ledger" : ""} />
                <button onClick={() => recordReceived(p)}
                  className="text-xs border border-ledger text-ledger px-2 py-1 hover:bg-ledger-soft">
                  + received
                </button>
              </div>
              {isOpen && (
                <table className="w-full text-sm ledger-grid">
                  <tbody>
                    {txns.map((t, i) => (
                      <tr key={t.txn.id + i} className={t.txn.status === "pending" ? "bg-pending-soft/40" : ""}>
                        <td className="px-4 py-1.5 w-28 text-xs text-ink-faint">{t.txn.date}</td>
                        <td className="px-2 py-1.5">{t.txn.description}
                          {t.txn.status === "pending" && <span className="text-pending text-xs"> · pending</span>}
                        </td>
                        <td className="px-4 py-1.5 text-right">
                          <Amount paise={t.amountPaise} signed />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-ink-faint">
        Positive entries increase what they owe you (their EMI hit your card);
        negative entries are money they returned.
      </p>
    </div>
  );
}

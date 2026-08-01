"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { Amount } from "@/components/amount";
import { formatPaise } from "@/lib/money";
import { toISODate } from "@/lib/ledger";
import type { Posting, RecurringTemplate, Transaction } from "@/lib/types";

export default function PlanPage() {
  const { supabase, accounts, balances, cycles, loading } = useLedger();
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [txns, setTxns] = useState<(Transaction & { postings: Posting[] })[]>([]);
  const [month, setMonth] = useState(() => toISODate(new Date()).slice(0, 7));

  const load = useCallback(async () => {
    const start = `${month}-01`;
    const end = toISODate(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    const [tRes, xRes] = await Promise.all([
      supabase.from("recurring_templates").select("*").eq("active", true).order("day_of_month"),
      supabase
        .from("transactions")
        .select("*, postings(*)")
        .not("recurring_template_id", "is", null)
        .gte("date", start)
        .lt("date", end),
    ]);
    setTemplates((tRes.data ?? []) as RecurringTemplate[]);
    setTxns((xRes.data ?? []) as (Transaction & { postings: Posting[] })[]);
  }, [supabase, month]);

  useEffect(() => {
    load();
  }, [load]);

  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  const isIncome = (t: RecurringTemplate) =>
    accountById(accounts, t.from_account_id)?.kind === "income";
  const isInternal = (t: RecurringTemplate) => {
    const from = accountById(accounts, t.from_account_id);
    const to = accountById(accounts, t.to_account_id);
    return from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";
  };
  const actualFor = (t: RecurringTemplate) => {
    const x = txns.find((x) => x.recurring_template_id === t.id);
    if (!x) return null;
    const neg = x.postings.find((p) => p.amount_paise < 0);
    return { txn: x, paise: neg ? -neg.amount_paise : 0 };
  };

  const plannedIn = templates.filter(isIncome).reduce((s, t) => s + t.amount_paise, 0);
  const committed = templates.filter((t) => !isIncome(t) && !isInternal(t)).reduce((s, t) => s + t.amount_paise, 0);
  const expectedBack = templates.reduce((s, t) => s + (t.reimburse_amount_paise ?? 0), 0);
  const actualOut = templates
    .filter((t) => !isIncome(t) && !isInternal(t))
    .reduce((s, t) => s + (actualFor(t)?.paise ?? 0), 0);

  const parentCards = active.filter((a) => a.subtype === "credit_card" && a.parent_id === null);
  const headingToBill = (cardId: string) =>
    [cardId, ...active.filter((a) => a.parent_id === cardId).map((a) => a.id)]
      .reduce((s, id) => s + -(cycles.get(id)?.spends_since_paise ?? 0), 0);
  const liquid = active
    .filter((a) => ["bank", "cash", "envelope"].includes(a.subtype))
    .reduce((s, a) => s + (balances.get(a.id)?.balance_paise ?? 0), 0);

  function shiftMonth(delta: number) {
    const [y, m] = month.split("-").map(Number);
    setMonth(toISODate(new Date(y, m - 1 + delta, 1)).slice(0, 7));
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>;

  const monthName = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <button onClick={() => shiftMonth(-1)} className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft">←</button>
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Plan</p>
          <h1 className="text-3xl">{monthName}</h1>
        </div>
        <button onClick={() => shiftMonth(1)} className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft">→</button>
      </div>

      <section className="grid sm:grid-cols-5 gap-2">
        <Stat label="Planned in" v={plannedIn} cls="text-ledger" />
        <Stat label="Committed out" v={committed} />
        <Stat label="Spent so far" v={actualOut} cls={actualOut > committed ? "text-debit" : ""} />
        <Stat label="Coming back" v={expectedBack} cls="text-ledger" />
        <Stat label="Left" v={plannedIn - committed + expectedBack}
          cls={plannedIn - committed + expectedBack >= 0 ? "text-ledger" : "text-debit"} />
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
          Planned vs actual
        </h2>
        <div className="border border-rule bg-paper-raised overflow-x-auto">
          <table className="ledger-grid w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="px-3 py-2 font-medium w-10">Day</th>
                <th className="px-2 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium text-right w-28">Planned</th>
                <th className="px-2 py-2 font-medium text-right w-28">Actual</th>
                <th className="px-2 py-2 font-medium text-right w-28">Diff</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => {
                const from = accountById(accounts, t.from_account_id);
                const to = accountById(accounts, t.to_account_id);
                const income = isIncome(t);
                const internal = isInternal(t);
                const actual = actualFor(t);
                const diff = actual ? actual.paise - t.amount_paise : null;
                return (
                  <tr key={t.id}>
                    <td className="px-3 py-1.5 amount text-ink-faint text-right">{t.day_of_month}</td>
                    <td className="px-2 py-1.5">
                      {t.name}
                      <span className="text-xs text-ink-faint"> · {from?.name}{internal ? " ⇄ " : " → "}{to?.name}</span>
                      {t.reimburse_account_id && t.reimburse_amount_paise ? (
                        <span className="text-[11px] text-ledger"> · {accountById(accounts, t.reimburse_account_id)?.name} returns {formatPaise(t.reimburse_amount_paise)}</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Amount paise={income ? t.amount_paise : -t.amount_paise} signed={!internal}
                        className={internal ? "text-ink-faint" : ""} />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {actual ? (
                        <span>
                          <Amount paise={income ? actual.paise : -actual.paise} signed={!internal}
                            className={internal ? "text-ink-faint" : ""} />
                          <span className="text-ledger text-xs"> ✓</span>
                        </span>
                      ) : (
                        <span className="text-xs text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {diff !== null && diff !== 0 ? (
                        <Amount paise={income ? diff : -diff} signed className="text-xs" />
                      ) : (
                        <span className="text-xs text-ink-faint">{diff === 0 ? "on plan" : ""}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-faint mt-2">
          Edit planned items under Recurring — amounts, days, who repays.
        </p>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
          Card bills forming
        </h2>
        <div className="border border-rule bg-paper-raised divide-y divide-rule">
          {parentCards.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-2">
              <p className="text-sm flex-1">{c.name}
                <span className="text-xs text-ink-faint"> · statement {c.statement_day}, due {c.due_day}</span>
              </p>
              <Amount paise={headingToBill(c.id)} className="text-pending" />
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-faint mt-2">
          Liquid today (banks + cash + set aside): <span className="amount">{formatPaise(liquid)}</span>
        </p>
      </section>
    </div>
  );
}

function Stat({ label, v, cls = "" }: { label: string; v: number; cls?: string }) {
  return (
    <div className="border border-rule bg-paper-raised px-4 py-3">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className={`amount text-lg mt-1 ${cls}`}>{formatPaise(v)}</p>
    </div>
  );
}

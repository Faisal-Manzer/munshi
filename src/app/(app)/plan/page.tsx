"use client";

import { useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { Amount } from "@/components/amount";
import { formatPaise } from "@/lib/money";
import type { RecurringTemplate } from "@/lib/types";

export default function PlanPage() {
  const { supabase, accounts, balances, cycles, loading } = useLedger();
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);

  useEffect(() => {
    supabase
      .from("recurring_templates")
      .select("*")
      .eq("active", true)
      .order("day_of_month")
      .then(({ data }) => setTemplates((data ?? []) as RecurringTemplate[]));
  }, [supabase]);

  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthName = next.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const isIncome = (t: RecurringTemplate) =>
    accountById(accounts, t.from_account_id)?.kind === "income";
  const isInternal = (t: RecurringTemplate) => {
    const from = accountById(accounts, t.from_account_id);
    const to = accountById(accounts, t.to_account_id);
    return from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";
  };

  const plannedIn = templates.filter(isIncome).reduce((s, t) => s + t.amount_paise, 0);
  const committed = templates.filter((t) => !isIncome(t) && !isInternal(t)).reduce((s, t) => s + t.amount_paise, 0);
  const expectedBack = templates.reduce((s, t) => s + (t.reimburse_amount_paise ?? 0), 0);

  const parentCards = active.filter((a) => a.subtype === "credit_card" && a.parent_id === null);
  const headingToBill = (cardId: string) =>
    [cardId, ...active.filter((a) => a.parent_id === cardId).map((a) => a.id)]
      .reduce((s, id) => s + -(cycles.get(id)?.spends_since_paise ?? 0), 0);
  const liquid = active
    .filter((a) => ["bank", "cash", "envelope"].includes(a.subtype))
    .reduce((s, a) => s + (balances.get(a.id)?.balance_paise ?? 0), 0);

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Planning</p>
        <h1 className="text-3xl">{monthName}</h1>
      </div>

      <section className="grid sm:grid-cols-4 gap-2">
        <Stat label="Expected in" v={plannedIn} cls="text-ledger" />
        <Stat label="Committed out" v={committed} />
        <Stat label="Coming back" v={expectedBack} cls="text-ledger" />
        <Stat label="Left" v={plannedIn - committed + expectedBack}
          cls={plannedIn - committed + expectedBack >= 0 ? "text-ledger" : "text-debit"} />
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
          The month, day by day
        </h2>
        <div className="border border-rule bg-paper-raised divide-y divide-rule">
          {templates.map((t) => {
            const from = accountById(accounts, t.from_account_id);
            const to = accountById(accounts, t.to_account_id);
            const income = isIncome(t);
            const internal = isInternal(t);
            return (
              <div key={t.id} className="flex items-center gap-3 px-4 py-2">
                <span className="amount w-8 text-right text-ink-faint">{t.day_of_month}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{t.name}
                    <span className="text-xs text-ink-faint"> · {from?.name}{internal ? " ⇄ " : " → "}{to?.name}</span>
                  </p>
                  {t.reimburse_account_id && t.reimburse_amount_paise && (
                    <p className="text-[11px] text-ledger">
                      {accountById(accounts, t.reimburse_account_id)?.name} returns {formatPaise(t.reimburse_amount_paise)} ~{t.reimburse_expected_day ?? t.day_of_month}th
                    </p>
                  )}
                </div>
                <Amount
                  paise={income ? t.amount_paise : internal ? t.amount_paise : -t.amount_paise}
                  signed={!internal}
                  className={internal ? "text-ink-faint" : ""}
                />
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
          Card bills forming (spends since last statement)
        </h2>
        <div className="border border-rule bg-paper-raised divide-y divide-rule">
          {parentCards.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-2">
              <p className="text-sm flex-1">{c.name}
                <span className="text-xs text-ink-faint"> · cuts {c.statement_day}rd, due {c.due_day}th</span>
              </p>
              <Amount paise={headingToBill(c.id)} className="text-pending" />
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-faint mt-2">
          Liquid today (banks + cash + envelopes): <span className="amount">{formatPaise(liquid)}</span>
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

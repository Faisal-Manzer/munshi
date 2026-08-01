"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { Amount } from "@/components/amount";
import { formatPaise } from "@/lib/money";
import { subtreeBalance, toISODate } from "@/lib/ledger";
import type { RecurringTemplate, Transaction } from "@/lib/types";

interface CalItem {
  day: number;
  label: string;
  paise: number; // + inflow, - outflow
  kind: "in" | "out" | "cc" | "receivable";
  done?: boolean;
}

export default function OverviewPage() {
  const { supabase, accounts, balances, loading } = useLedger();
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [offset, setOffset] = useState(1); // 0 = this month, 1 = next month
  const [postedTxns, setPostedTxns] = useState<Transaction[]>([]);

  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const monthKey = toISODate(target).slice(0, 7);
  const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const monthName = target.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const load = useCallback(async () => {
    const start = `${monthKey}-01`;
    const end = toISODate(new Date(target.getFullYear(), target.getMonth() + 1, 1));
    const [tRes, xRes] = await Promise.all([
      supabase.from("recurring_templates").select("*").eq("active", true),
      supabase
        .from("transactions")
        .select("*")
        .not("recurring_template_id", "is", null)
        .gte("date", start)
        .lt("date", end),
    ]);
    setTemplates((tRes.data ?? []) as RecurringTemplate[]);
    setPostedTxns((xRes.data ?? []) as Transaction[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, monthKey]);

  useEffect(() => {
    load();
  }, [load]);

  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const cards = active.filter((a) => a.subtype === "credit_card" && a.parent_id === null);
  const people = active.filter((a) => a.subtype === "receivable");

  // classify templates
  const inflows = templates.filter(
    (t) => accountById(accounts, t.from_account_id)?.kind === "income"
  );
  const outflows = templates.filter(
    (t) => accountById(accounts, t.from_account_id)?.kind !== "income"
  );

  const salaryIn = inflows.reduce((s, t) => s + t.amount_paise, 0);
  // internal moves (bank -> bank/envelope, pre-funding for autodebits) are not spend;
  // the downstream expense/EMI template counts the real outflow once
  const isInternalMove = (t: RecurringTemplate) =>
    accountById(accounts, t.from_account_id)?.kind === "asset" &&
    accountById(accounts, t.to_account_id)?.kind === "asset" &&
    accountById(accounts, t.to_account_id)?.subtype !== "receivable";
  const committedOut = outflows
    .filter((t) => !isInternalMove(t))
    .reduce((s, t) => s + t.amount_paise, 0);
  const expectedBack = templates.reduce(
    (s, t) => s + (t.reimburse_amount_paise ?? 0),
    0
  );
  const ccDueTotal = cards.reduce(
    (s, c) => s + Math.max(0, -subtreeBalance(accounts, balances, c.id)),
    0
  );

  // calendar items
  const items: CalItem[] = [];
  for (const t of templates) {
    const posted = postedTxns.find((x) => x.recurring_template_id === t.id);
    const isIn = accountById(accounts, t.from_account_id)?.kind === "income";
    items.push({
      day: Math.min(t.day_of_month, daysInMonth),
      label: t.name,
      paise: isIn ? t.amount_paise : -t.amount_paise,
      kind: isIn ? "in" : "out",
      done: posted?.status === "done",
    });
    if (t.reimburse_account_id && t.reimburse_amount_paise) {
      items.push({
        day: Math.min(t.reimburse_expected_day ?? t.day_of_month, daysInMonth),
        label: `${accountById(accounts, t.reimburse_account_id)?.name} repays ${t.name}`,
        paise: t.reimburse_amount_paise,
        kind: "receivable",
      });
    }
  }
  for (const c of cards) {
    if (!c.due_day) continue;
    const owed = Math.max(0, -subtreeBalance(accounts, balances, c.id));
    if (owed === 0) continue;
    items.push({
      day: Math.min(c.due_day, daysInMonth),
      label: `${c.name} bill due`,
      paise: -owed,
      kind: "cc",
    });
  }
  const byDay = new Map<number, CalItem[]>();
  for (const it of items) {
    byDay.set(it.day, [...(byDay.get(it.day) ?? []), it]);
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>;

  const empty = active.length === 0;

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Overview</p>
          <h1 className="text-3xl">{monthName}</h1>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => setOffset((o) => o - 1)} className="border border-rule px-2 py-1 hover:bg-ledger-soft">←</button>
          <button onClick={() => setOffset(1)} className={`border px-2 py-1 ${offset === 1 ? "border-ledger text-ledger" : "border-rule"}`}>
            next month
          </button>
          <button onClick={() => setOffset((o) => o + 1)} className="border border-rule px-2 py-1 hover:bg-ledger-soft">→</button>
        </div>
      </div>

      {empty ? (
        <div className="border border-dashed border-rule p-8 text-center space-y-2">
          <p className="text-sm text-ink-soft">Your books are empty.</p>
          <p className="text-sm text-ink-faint">
            Start under <a href="/accounts" className="text-ledger underline">Accounts</a> —
            add banks, cards (with due dates), people and expense categories.
            Then set up <a href="/recurring" className="text-ledger underline">Recurring</a> for
            salary, rent and EMIs.
          </p>
        </div>
      ) : (
        <>
          {/* Salary vs committed */}
          <section className="grid sm:grid-cols-4 gap-2">
            <Stat label="Expected in" value={salaryIn} tone="in" />
            <Stat label="Committed out (recurring + EMI)" value={committedOut} tone="out" />
            <Stat label="Card bills outstanding" value={ccDueTotal} tone="out" />
            <Stat
              label="Left after commitments"
              value={salaryIn - committedOut + expectedBack}
              tone={salaryIn - committedOut + expectedBack >= 0 ? "in" : "out"}
              hint={expectedBack > 0 ? `includes ${formatPaise(expectedBack)} coming back` : undefined}
            />
          </section>

          {/* CC dues timeline */}
          <section>
            <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
              Card bills, in due order
            </h2>
            <div className="border border-rule bg-paper-raised divide-y divide-rule">
              {cards.length === 0 && (
                <p className="text-sm text-ink-faint p-3">No credit cards yet.</p>
              )}
              {cards
                .slice()
                .sort((a, b) => (a.due_day ?? 32) - (b.due_day ?? 32))
                .map((c) => {
                  const owed = -subtreeBalance(accounts, balances, c.id);
                  const subs = active.filter((s) => s.parent_id === c.id);
                  const gap = c.reported_balance_paise !== null ? -c.reported_balance_paise - owed : null;
                  return (
                    <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="w-14 text-center border border-rule bg-paper py-1">
                        <p className="text-[10px] uppercase text-ink-faint leading-none">due</p>
                        <p className="amount text-base">{c.due_day ?? "—"}</p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">{c.name}</p>
                        <p className="text-xs text-ink-faint">
                          {subs.length > 0 && `incl. ${subs.map((s) => s.name).join(", ")} · `}
                          {gap !== null && gap !== 0 && (
                            <span className="text-debit">{formatPaise(Math.abs(gap))} {gap > 0 ? "unlogged on card" : "over-logged"} · </span>
                          )}
                          statement {c.statement_day ? `on ${c.statement_day}` : "—"}
                        </p>
                      </div>
                      <Amount paise={Math.max(0, owed)} className={owed > 0 ? "text-debit" : ""} />
                    </div>
                  );
                })}
            </div>
          </section>

          {/* Cash-flow calendar — the ledger page */}
          <section>
            <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
              Cash-flow calendar
            </h2>
            <div className="border border-rule bg-paper-raised">
              {Array.from({ length: daysInMonth }, (_, i) => i + 1)
                .filter((d) => byDay.has(d))
                .map((d) => (
                  <div key={d} className="flex gap-3 px-4 py-2 border-b border-rule last:border-b-0">
                    <p className="amount w-8 text-right text-ink-faint pt-0.5">{d}</p>
                    <div className="flex-1 divide-y divide-rule/60">
                      {byDay.get(d)!.map((it, i) => (
                        <div key={i} className="flex items-center gap-2 py-0.5">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                            it.kind === "in" ? "bg-ledger"
                            : it.kind === "receivable" ? "bg-ledger/50"
                            : it.kind === "cc" ? "bg-debit"
                            : "bg-pending"
                          }`} />
                          <p className="text-sm flex-1 min-w-0 truncate">
                            {it.label}
                            {it.done && <span className="text-ledger text-xs"> ✓ paid</span>}
                          </p>
                          <Amount paise={it.paise} signed />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              {byDay.size === 0 && (
                <p className="text-sm text-ink-faint p-4">
                  Nothing scheduled — add recurring items and card due dates to
                  see the month laid out day by day.
                </p>
              )}
            </div>
          </section>

          {/* Receivables */}
          <section>
            <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
              Coming back to you
            </h2>
            <div className="border border-rule bg-paper-raised divide-y divide-rule">
              {people.filter((p) => (balances.get(p.id)?.balance_paise ?? 0) !== 0).length === 0 && (
                <p className="text-sm text-ink-faint p-3">Nobody owes you right now.</p>
              )}
              {people
                .filter((p) => (balances.get(p.id)?.balance_paise ?? 0) !== 0)
                .map((p) => (
                  <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                    <p className="text-sm flex-1">{p.name}</p>
                    <Amount paise={balances.get(p.id)?.balance_paise ?? 0} className="text-ledger" />
                  </div>
                ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({
  label, value, tone, hint,
}: {
  label: string;
  value: number;
  tone: "in" | "out";
  hint?: string;
}) {
  return (
    <div className="border border-rule bg-paper-raised px-4 py-3">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className={`amount text-lg mt-1 ${tone === "in" ? "text-ledger" : "text-ink"}`}>
        {formatPaise(value)}
      </p>
      {hint && <p className="text-[11px] text-ink-faint mt-0.5">{hint}</p>}
    </div>
  );
}

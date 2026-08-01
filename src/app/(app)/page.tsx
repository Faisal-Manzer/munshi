"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { createEntry, rewriteEntry } from "@/lib/postings";
import { Amount } from "@/components/amount";
import { formatPaise, parseRupees } from "@/lib/money";
import { subtreeBalance, toISODate } from "@/lib/ledger";
import {
  TAG_LABEL,
  type Account,
  type Posting,
  type RecurringTemplate,
  type SpendTag,
  type Transaction,
} from "@/lib/types";

interface TxnRow {
  kind: "txn";
  date: string;
  txn: Transaction;
  fromId: string | null;
  toId: string | null;
  amountPaise: number;
}
interface VirtualRow {
  kind: "virtual";
  date: string;
  template: RecurringTemplate;
}
type Row = TxnRow | VirtualRow;

export default function BookPage() {
  const { supabase, accounts, balances, cycles, loading, reload } = useLedger();
  const [txns, setTxns] = useState<(Transaction & { postings: Posting[] })[]>([]);
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [month, setMonth] = useState(() => toISODate(new Date()).slice(0, 7));
  const [error, setError] = useState<string | null>(null);

  const today = toISODate(new Date());
  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  const load = useCallback(async () => {
    const start = `${month}-01`;
    const end = toISODate(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    const [xRes, tRes] = await Promise.all([
      supabase
        .from("transactions")
        .select("*, postings(*)")
        .gte("date", start)
        .lt("date", end)
        .order("date")
        .order("created_at"),
      supabase.from("recurring_templates").select("*").eq("active", true),
    ]);
    if (xRes.error || tRes.error) {
      setError(xRes.error?.message ?? tRes.error?.message ?? "load failed");
      return;
    }
    setTxns(xRes.data as (Transaction & { postings: Posting[] })[]);
    setTemplates(tRes.data as RecurringTemplate[]);
  }, [supabase, month]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshAll = useCallback(
    () => Promise.all([load(), reload()]),
    [load, reload]
  );

  // ---- build unified rows
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const rows: Row[] = [];
  for (const t of txns) {
    const neg = t.postings.find((p) => p.amount_paise < 0);
    const pos = t.postings.filter((p) => p.amount_paise > 0);
    const to = pos.find((p) => p.account_id !== t.reimburse_account_id) ?? pos[0];
    rows.push({
      kind: "txn",
      date: t.date,
      txn: t,
      fromId: neg?.account_id ?? null,
      toId: to?.account_id ?? null,
      amountPaise: neg ? -neg.amount_paise : pos.reduce((s, p) => s + p.amount_paise, 0),
    });
  }
  for (const t of templates) {
    if (txns.some((x) => x.recurring_template_id === t.id)) continue;
    const day = Math.min(t.day_of_month, daysInMonth);
    rows.push({
      kind: "virtual",
      date: `${month}-${String(day).padStart(2, "0")}`,
      template: t,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // ---- summary
  const isIncomeT = (t: RecurringTemplate) =>
    accountById(accounts, t.from_account_id)?.kind === "income";
  const isInternalT = (t: RecurringTemplate) => {
    const from = accountById(accounts, t.from_account_id);
    const to = accountById(accounts, t.to_account_id);
    return from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";
  };
  const plannedIn = templates.filter(isIncomeT).reduce((s, t) => s + t.amount_paise, 0);
  const committed = templates
    .filter((t) => !isIncomeT(t) && !isInternalT(t))
    .reduce((s, t) => s + t.amount_paise, 0);
  const expectedBack = templates.reduce((s, t) => s + (t.reimburse_amount_paise ?? 0), 0);
  const avoidable = txns
    .filter((t) => t.tag)
    .reduce((s, t) => {
      const neg = t.postings.find((p) => p.amount_paise < 0);
      return s + (neg ? -neg.amount_paise : 0);
    }, 0);

  const parentCards = active.filter((a) => a.subtype === "credit_card" && a.parent_id === null);
  const cardDueNow = (card: Account) => {
    let billed = 0, paid = 0;
    for (const c of [card, ...active.filter((a) => a.parent_id === card.id)]) {
      const cy = cycles.get(c.id);
      if (!cy) continue;
      billed += -cy.billed_paise;
      paid += cy.payments_since_paise;
    }
    return Math.max(0, billed - paid);
  };
  const cardUnbilled = (card: Account) => {
    let s = 0;
    for (const c of [card, ...active.filter((a) => a.parent_id === card.id)]) {
      s += -(cycles.get(c.id)?.spends_since_paise ?? 0);
    }
    return s;
  };
  const totalDue = parentCards.reduce((s, c) => s + cardDueNow(c), 0);

  // ---- actions
  async function postVirtual(t: RecurringTemplate) {
    const input = prompt(`Post "${t.name}" — actual amount ₹:`, String(t.amount_paise / 100));
    if (input === null) return;
    const paise = parseRupees(input);
    if (!paise || paise <= 0) return;
    const scale = paise / t.amount_paise;
    try {
      await createEntry(supabase, {
        date: today,
        description: t.name,
        status: "done",
        fromAccountId: t.from_account_id,
        toAccountId: t.to_account_id,
        amountPaise: paise,
        reimburseAccountId: t.reimburse_account_id,
        reimbursePaise: t.reimburse_amount_paise
          ? Math.round(t.reimburse_amount_paise * scale)
          : null,
        recurringTemplateId: t.id,
      });
      setError(null);
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "post failed");
    }
  }

  async function markPaid(row: TxnRow) {
    await supabase
      .from("transactions")
      .update({ status: "done", date: today })
      .eq("id", row.txn.id);
    await refreshAll();
  }

  async function setTag(row: TxnRow, tag: string) {
    await supabase
      .from("transactions")
      .update({ tag: tag || null })
      .eq("id", row.txn.id);
    await refreshAll();
  }

  async function remove(row: TxnRow) {
    if (!confirm(`Delete "${row.txn.description}"?`)) return;
    await supabase.from("transactions").delete().eq("id", row.txn.id);
    await refreshAll();
  }

  function shiftMonth(delta: number) {
    const [y, m] = month.split("-").map(Number);
    setMonth(toISODate(new Date(y, m - 1 + delta, 1)).slice(0, 7));
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading the book…</p>;

  const monthName = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => shiftMonth(-1)} className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft">←</button>
          <h1 className="text-3xl">{monthName}</h1>
          <button onClick={() => shiftMonth(1)} className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft">→</button>
        </div>
        <div className="flex gap-4 text-sm flex-wrap">
          <Headline label="in" paise={plannedIn} cls="text-ledger" />
          <Headline label="committed" paise={committed} />
          <Headline label="card due" paise={totalDue} cls={totalDue > 0 ? "text-debit" : ""} />
          <Headline label="coming back" paise={expectedBack} cls="text-ledger" />
          <Headline label="left" paise={plannedIn - committed + expectedBack} cls={plannedIn - committed + expectedBack >= 0 ? "text-ledger" : "text-debit"} />
          {avoidable > 0 && <Headline label="avoidable" paise={avoidable} cls="text-pending" />}
        </div>
      </div>

      {error && <p className="text-sm text-debit border border-debit-soft bg-debit-soft px-3 py-2">{error}</p>}

      <div className="grid lg:grid-cols-[1fr_290px] gap-5 items-start">
        {/* ledger */}
        <div className="border border-rule bg-paper-raised">
          <QuickAdd accounts={active} onCreate={async (e) => {
            try {
              await createEntry(supabase, e);
              setError(null);
              await refreshAll();
              return true;
            } catch (err) {
              setError(err instanceof Error ? err.message : "failed");
              return false;
            }
          }} />
          <table className="ledger-grid w-full text-sm">
            <tbody>
              {rows.map((row, i) => {
                if (row.kind === "virtual") {
                  const t = row.template;
                  const overdue = row.date < today;
                  const from = accountById(accounts, t.from_account_id);
                  const isIn = from?.kind === "income";
                  return (
                    <tr key={"v" + t.id} className={overdue ? "bg-debit-soft/40" : "bg-paper"}>
                      <td className="px-3 py-2 w-10 text-right amount text-ink-faint">{Number(row.date.slice(8, 10))}</td>
                      <td className="px-2 py-2">
                        <span className={overdue ? "text-debit" : "text-ink-soft"}>{t.name}</span>
                        <span className="text-xs text-ink-faint"> · {from?.name} → {accountById(accounts, t.to_account_id)?.name}</span>
                        {overdue && <span className="text-xs text-debit font-medium"> · overdue</span>}
                      </td>
                      <td className="px-2 py-2 text-right w-32">
                        <Amount paise={isIn ? t.amount_paise : -t.amount_paise} signed />
                      </td>
                      <td className="px-2 py-2 w-40 text-right" colSpan={2}>
                        <button onClick={() => postVirtual(t)}
                          className={`text-xs border px-2 py-1 ${overdue ? "border-debit text-debit hover:bg-debit-soft" : "border-ledger text-ledger hover:bg-ledger-soft"}`}>
                          post today
                        </button>
                      </td>
                    </tr>
                  );
                }
                const t = row.txn;
                const from = row.fromId ? accountById(accounts, row.fromId) : undefined;
                const to = row.toId ? accountById(accounts, row.toId) : undefined;
                const isIn = from?.kind === "income" || (from?.subtype === "receivable" && to?.kind === "asset");
                const isInternal = from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";
                const pending = t.status === "pending";
                return (
                  <tr key={t.id} className={pending ? "bg-pending-soft/40" : ""}>
                    <td className="px-3 py-1.5 w-10 text-right amount text-ink-faint">{Number(t.date.slice(8, 10))}</td>
                    <td className="px-2 py-1.5">
                      {t.description}
                      <span className="text-xs text-ink-faint"> · {from?.name}{isInternal ? " ⇄ " : " → "}{to?.name}</span>
                      {t.recurring_template_id && <span className="text-xs text-ledger"> ✓</span>}
                      {pending && <span className="text-xs text-pending"> · pending</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right w-32">
                      <Amount paise={isIn ? row.amountPaise : isInternal ? row.amountPaise : -row.amountPaise}
                        signed={!isInternal} className={isInternal ? "text-ink-faint" : ""} />
                    </td>
                    <td className="px-2 py-1.5 w-28">
                      <select value={t.tag ?? ""} onChange={(e) => setTag(row, e.target.value)}
                        className={`text-xs w-full bg-transparent ${t.tag ? "text-pending" : "text-ink-faint"}`}>
                        <option value="">— tag</option>
                        {Object.entries(TAG_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 w-12 text-right whitespace-nowrap">
                      {pending && (
                        <button onClick={() => markPaid(row)} className="text-xs text-ledger hover:underline mr-1">paid</button>
                      )}
                      <button onClick={() => remove(row)} className="text-ink-faint hover:text-debit">×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="text-sm text-ink-faint p-4">Empty month — add an entry above.</p>
          )}
        </div>

        {/* sidebar */}
        <aside className="space-y-4">
          <SideBlock title="Accounts">
            {active.filter((a) => ["bank", "cash", "investment"].includes(a.subtype)).map((b) => {
              const total = subtreeBalance(accounts, balances, b.id);
              const own = balances.get(b.id)?.balance_paise ?? 0;
              const envs = active.filter((e) => e.parent_id === b.id);
              return (
                <div key={b.id} className="px-3 py-1.5 flex items-baseline justify-between gap-2">
                  <div>
                    <p className="text-sm">{b.name}</p>
                    {envs.length > 0 && (
                      <p className="text-[11px] text-ink-faint">
                        free {formatPaise(own)} · aside {formatPaise(total - own)}
                      </p>
                    )}
                  </div>
                  <Amount paise={total} />
                </div>
              );
            })}
          </SideBlock>

          <SideBlock title="Cards">
            {parentCards.map((c) => {
              const due = cardDueNow(c);
              const unbilled = cardUnbilled(c);
              return (
                <div key={c.id} className="px-3 py-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm">{c.name}</p>
                    <Amount paise={due} className={due > 0 ? "text-debit" : "text-ink-faint"} />
                  </div>
                  <p className="text-[11px] text-ink-faint">
                    {due > 0 ? `bill due ${c.due_day ?? "—"}th` : "bill clear"} ·
                    unbilled {formatPaise(unbilled)} (cuts {c.statement_day ?? "—"}rd)
                  </p>
                </div>
              );
            })}
          </SideBlock>

          <SideBlock title="People">
            {active.filter((a) => a.subtype === "receivable").map((p) => {
              const bal = balances.get(p.id)?.balance_paise ?? 0;
              if (bal === 0) return null;
              return (
                <div key={p.id} className="px-3 py-1.5 flex items-baseline justify-between gap-2">
                  <p className="text-sm">{p.name}
                    <span className="text-[11px] text-ink-faint"> {bal > 0 ? "owes you" : "you owe"}</span>
                  </p>
                  <Amount paise={Math.abs(bal)} className={bal > 0 ? "text-ledger" : "text-debit"} />
                </div>
              );
            })}
          </SideBlock>

          <SideBlock title="Loans">
            {active.filter((a) => a.subtype === "loan").map((l) => (
              <div key={l.id} className="px-3 py-1.5 flex items-baseline justify-between gap-2">
                <p className="text-sm">{l.name}</p>
                <Amount paise={-(balances.get(l.id)?.balance_paise ?? 0)} />
              </div>
            ))}
          </SideBlock>
        </aside>
      </div>
    </div>
  );
}

function Headline({ label, paise, cls = "" }: { label: string; paise: number; cls?: string }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</p>
      <p className={`amount ${cls}`}>{formatPaise(paise)}</p>
    </div>
  );
}

function SideBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-rule bg-paper-raised">
      <p className="text-[10px] uppercase tracking-[0.15em] text-ink-faint px-3 pt-2 pb-1">{title}</p>
      <div className="divide-y divide-rule/60 pb-1">{children}</div>
    </div>
  );
}

function QuickAdd({
  accounts, onCreate,
}: {
  accounts: Account[];
  onCreate: (e: Parameters<typeof createEntry>[1]) => Promise<boolean>;
}) {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [tag, setTagV] = useState("");

  const fromChoices = accounts.filter((a) =>
    ["bank", "envelope", "cash", "investment", "credit_card", "receivable", "salary", "other_income"].includes(a.subtype)
  );
  const toChoices = accounts.filter((a) =>
    !["salary", "other_income", "opening_balance"].includes(a.subtype)
  );
  const spends = accounts.find((a) => a.name === "Spends" && a.kind === "expense");

  async function submit() {
    const paise = parseRupees(amount);
    if (!desc.trim() || !fromId || !paise || paise <= 0) return;
    const ok = await onCreate({
      date,
      description: desc.trim(),
      status: "done",
      fromAccountId: fromId,
      toAccountId: toId || spends?.id || "",
      amountPaise: paise,
      tag: tag || null,
    });
    if (ok) {
      setDesc("");
      setAmount("");
      setTagV("");
    }
  }

  return (
    <div className="flex flex-wrap gap-0 border-b border-rule-strong bg-ledger-soft/50"
      onKeyDown={(e) => e.key === "Enter" && submit()}>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
        className="px-2 py-2 text-sm bg-transparent w-32" />
      <input value={desc} onChange={(e) => setDesc(e.target.value)}
        placeholder="What happened… (Enter saves)"
        className="px-2 py-2 text-sm bg-transparent flex-1 min-w-40" />
      <input value={amount} onChange={(e) => setAmount(e.target.value)}
        placeholder="₹" inputMode="decimal"
        className="px-2 py-2 text-sm bg-transparent w-24 text-right amount" />
      <select value={fromId} onChange={(e) => setFromId(e.target.value)}
        className="px-1 py-2 text-sm bg-transparent w-32">
        <option value="">from…</option>
        {fromChoices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select value={toId} onChange={(e) => setToId(e.target.value)}
        className="px-1 py-2 text-sm bg-transparent w-32">
        <option value="">→ Spends</option>
        {toChoices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select value={tag} onChange={(e) => setTagV(e.target.value)}
        className="px-1 py-2 text-xs bg-transparent w-24 text-ink-faint">
        <option value="">tag…</option>
        {Object.entries(TAG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <button onClick={submit} className="px-3 text-ledger text-sm font-medium hover:underline">Add</button>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { Amount } from "@/components/amount";
import { AccountSelect } from "@/components/account-select";
import { Modal } from "@/components/modal";
import { TemplateModal } from "@/components/template-form";
import { createEntry, rewriteEntry, type EntryInput } from "@/lib/postings";
import { formatPaise, parseRupees } from "@/lib/money";
import { toISODate } from "@/lib/ledger";
import { Pencil, Plus } from "lucide-react";
import type { Account, Posting, RecurringTemplate, Transaction } from "@/lib/types";

type Txn = Transaction & { postings: Posting[] };

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

function clampDate(y: number, m: number, day: number): Date {
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, last));
}

export default function PlanPage() {
  const { supabase, accounts, cycles, loading, reload } = useLedger();
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [oneOffs, setOneOffs] = useState<Txn[]>([]);
  const [doneCounts, setDoneCounts] = useState<Map<string, number>>(new Map());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringTemplate | null>(null);
  const [leftOpen, setLeftOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = new Date();
  const todayISO = toISODate(today);
  // plan is for NEXT month by default — this month is assumed to resolve itself
  const nextMonth = toISODate(new Date(today.getFullYear(), today.getMonth() + 1, 1)).slice(0, 7);
  const [month, setMonth] = useState(nextMonth);

  const load = useCallback(async () => {
    const start = `${month}-01`;
    const end = toISODate(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    const [tRes, oRes, cRes] = await Promise.all([
      supabase.from("recurring_templates").select("*").eq("active", true).order("day_of_month"),
      supabase
        .from("transactions")
        .select("*, postings(*)")
        .is("recurring_template_id", null)
        .eq("status", "pending")
        .gte("date", start)
        .lt("date", end)
        .order("date"),
      supabase
        .from("transactions")
        .select("recurring_template_id")
        .not("recurring_template_id", "is", null)
        .eq("status", "done"),
    ]);
    if (tRes.error || oRes.error) {
      setError(tRes.error?.message ?? oRes.error?.message ?? "load failed");
      return;
    }
    setTemplates(tRes.data as RecurringTemplate[]);
    setOneOffs(oRes.data as Txn[]);
    const counts = new Map<string, number>();
    for (const r of (cRes.data ?? []) as { recurring_template_id: string }[]) {
      counts.set(r.recurring_template_id, (counts.get(r.recurring_template_id) ?? 0) + 1);
    }
    setDoneCounts(counts);
  }, [supabase, month]);

  useEffect(() => {
    load();
  }, [load]);

  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  const isIncome = (t: RecurringTemplate) =>
    accountById(accounts, t.from_account_id)?.kind === "income";
  const isInternal = (t: RecurringTemplate) => {
    if (t.is_budget) return false;
    const from = accountById(accounts, t.from_account_id);
    const to = accountById(accounts, t.to_account_id);
    return from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";
  };

  // ---- one-off classification (pending txns in the plan month)
  const oneOffKind = (x: Txn): "in" | "out" | "back" | "card" | "internal" => {
    const neg = x.postings.find((p) => p.amount_paise < 0);
    const pos = x.postings.find(
      (p) => p.amount_paise > 0 && p.account_id !== x.reimburse_account_id
    );
    const from = neg ? accountById(accounts, neg.account_id) : undefined;
    const to = pos ? accountById(accounts, pos.account_id) : undefined;
    if (from?.kind === "income") return "in";
    if (from?.subtype === "receivable") return "back";
    if (from?.subtype === "credit_card") return "card";
    if (to?.kind === "asset" && to?.subtype !== "receivable") return "internal";
    return "out";
  };
  const oneOffAmount = (x: Txn) => {
    const neg = x.postings.find((p) => p.amount_paise < 0);
    return neg ? -neg.amount_paise : 0;
  };
  const oneOffIn = oneOffs.filter((x) => oneOffKind(x) === "in").reduce((s, x) => s + oneOffAmount(x), 0);
  const oneOffOut = oneOffs.filter((x) => oneOffKind(x) === "out").reduce((s, x) => s + oneOffAmount(x), 0);
  const oneOffBack = oneOffs.filter((x) => oneOffKind(x) === "back").reduce((s, x) => s + oneOffAmount(x), 0);

  // ---- fixed monthly plan (budgets + salary are the same every month)
  const plannedIn = templates.filter(isIncome).reduce((s, t) => s + t.amount_paise, 0) + oneOffIn;
  const committed = templates
    .filter((t) => {
      if (isIncome(t) || isInternal(t)) return false;
      return accountById(accounts, t.from_account_id)?.subtype !== "credit_card";
    })
    .reduce((s, t) => s + t.amount_paise, 0) + oneOffOut;
  const expectedBack =
    templates.reduce((s, t) => s + (t.reimburse_amount_paise ?? 0), 0) + oneOffBack;

  // ---- card dues landing in the plan month (carry-over from this month's cycle)
  const parentCards = active.filter((a) => a.subtype === "credit_card" && a.parent_id === null);
  const subtreeIds = (card: Account) =>
    [card.id, ...active.filter((a) => a.parent_id === card.id).map((a) => a.id)];

  interface CardPlan {
    card: Account;
    dueDate: Date;
    stmtDate: Date;
    unbilledNow: number;   // real swipes already in the cycle window
    recurring: number;     // card-charged templates still to land before the statement
    planned: number;       // one-off pending card txns inside the window
    total: number;
    estimateOnly: boolean; // window too far out — recurring only
  }

  const cardPlans: CardPlan[] = parentCards.flatMap((card) => {
    const s = card.statement_day, dd = card.due_day;
    if (!s || !dd) return [];
    // find the statement whose DUE lands in the plan month
    for (let k = 0; k < 6; k++) {
      const st = clampDate(today.getFullYear(), today.getMonth() + k, s);
      const due = dd > s
        ? clampDate(st.getFullYear(), st.getMonth(), dd)
        : clampDate(st.getFullYear(), st.getMonth() + 1, dd);
      if (toISODate(due).slice(0, 7) !== month) continue;
      const windowStart = clampDate(st.getFullYear(), st.getMonth() - 1, s);
      const ids = subtreeIds(card);
      // real spends already made inside this window (cycle view counts since last cutoff)
      const windowOpen = windowStart <= today && today < st;
      const unbilledNow = windowOpen
        ? ids.reduce((sum, id) => sum + -(cycles.get(id)?.spends_since_paise ?? 0), 0)
        : 0;
      // card-charged recurrings landing after today, on or before the statement
      const recurring = templates
        .filter((t) => ids.includes(t.from_account_id))
        .reduce((sum, t) => {
          for (let j = 0; j < 3; j++) {
            const occ = clampDate(today.getFullYear(), today.getMonth() + j, t.day_of_month);
            if (occ > today && occ > windowStart && occ <= st) return sum + t.amount_paise;
          }
          return sum;
        }, 0);
      // planned one-off card swipes dated inside the window
      const planned = oneOffs
        .filter((x) => {
          const neg = x.postings.find((p) => p.amount_paise < 0);
          if (!neg || !ids.includes(neg.account_id)) return false;
          const d = new Date(x.date + "T00:00:00");
          return d > windowStart && d <= st;
        })
        .reduce((sum, x) => sum + oneOffAmount(x), 0);
      const estimateOnly = !windowOpen && windowStart > today;
      return [{
        card, dueDate: due, stmtDate: st, unbilledNow, recurring, planned,
        total: unbilledNow + recurring + planned,
        estimateOnly,
      }];
    }
    return [];
  });
  const cardDue = cardPlans.reduce((s, c) => s + c.total, 0);

  const left = plannedIn - committed - cardDue + expectedBack;

  // ---- one-off actions
  async function addOneOff(e: EntryInput) {
    try {
      await createEntry(supabase, { ...e, status: "pending" });
      setError(null);
      await Promise.all([load(), reload()]);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      return false;
    }
  }

  async function patchOneOff(x: Txn, patch: Partial<EntryInput>) {
    const neg = x.postings.find((p) => p.amount_paise < 0);
    const pos = x.postings.find(
      (p) => p.amount_paise > 0 && p.account_id !== x.reimburse_account_id
    );
    if (!neg || !pos) return;
    try {
      await rewriteEntry(supabase, x.id, {
        date: x.date,
        description: x.description,
        status: "pending",
        fromAccountId: neg.account_id,
        toAccountId: pos.account_id,
        amountPaise: -neg.amount_paise,
        reimburseAccountId: x.reimburse_account_id,
        reimbursePaise: x.reimburse_amount_paise,
        tag: x.tag,
        notes: x.notes,
        ...patch,
      });
      setError(null);
      await Promise.all([load(), reload()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    }
  }

  async function removeOneOff(x: Txn) {
    if (!confirm(`Delete "${x.description}"?`)) return;
    await supabase.from("transactions").delete().eq("id", x.id);
    await Promise.all([load(), reload()]);
  }

  function shiftMonth(delta: number) {
    const [y, m] = month.split("-").map(Number);
    setMonth(toISODate(new Date(y, m - 1 + delta, 1)).slice(0, 7));
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>;

  const monthName = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const currentMonth = todayISO.slice(0, 7);
  const isPastOrCurrent = month <= currentMonth;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => shiftMonth(-1)} className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft">←</button>
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Plan</p>
          <h1 className="text-3xl">{monthName}</h1>
        </div>
        <button onClick={() => shiftMonth(1)} className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft">→</button>
        {month !== nextMonth && (
          <button onClick={() => setMonth(nextMonth)}
            className="text-xs text-ink-faint hover:text-ledger underline decoration-dotted">
            back to next month
          </button>
        )}
        {isPastOrCurrent && (
          <p className="text-xs text-pending">
            {month === currentMonth ? "current" : "past"} month — the Book is the source of truth here; plan ahead instead
          </p>
        )}
      </div>

      {error && <p className="text-sm text-debit border border-debit-soft bg-debit-soft px-3 py-2">{error}</p>}

      <section className="grid sm:grid-cols-5 gap-2">
        <Stat label="Coming in" v={plannedIn} cls="text-ledger" />
        <Stat label="Cash committed" v={committed} />
        <Stat label="Card dues landing" v={cardDue} cls={cardDue > 0 ? "text-debit" : ""} />
        <Stat label="Coming back" v={expectedBack} cls="text-ledger" />
        <button onClick={() => setLeftOpen(true)} className="text-left" title="How is this calculated?">
          <Stat label="Left ⓘ" v={left} cls={left >= 0 ? "text-ledger" : "text-debit"} />
        </button>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
          Card dues in {monthName.split(" ")[0]}
        </h2>
        <div className="border border-rule bg-paper-raised divide-y divide-rule">
          {cardPlans.map((cp) => (
            <div key={cp.card.id} className="px-4 py-2">
              <div className="flex items-center gap-3">
                <p className="text-sm flex-1">
                  {cp.card.name}
                  <span className="text-xs text-ink-faint">
                    {" "}· bills {fmtDate(toISODate(cp.stmtDate))}, due {fmtDate(toISODate(cp.dueDate))}
                  </span>
                </p>
                <Amount paise={cp.total} className={cp.total > 0 ? "text-debit" : "text-ink-faint"} />
              </div>
              <p className="text-[11px] text-ink-faint">
                {cp.estimateOnly
                  ? "estimate — recurring card charges only, cycle hasn't started"
                  : [
                      cp.unbilledNow > 0 ? `${formatPaise(cp.unbilledNow)} already swiped` : null,
                      cp.recurring > 0 ? `${formatPaise(cp.recurring)} recurring to come` : null,
                      cp.planned > 0 ? `${formatPaise(cp.planned)} planned one-offs` : null,
                    ].filter(Boolean).join(" + ") || "nothing yet — ad-hoc swipes will add up here"}
              </p>
            </div>
          ))}
          {cardPlans.length === 0 && (
            <p className="text-sm text-ink-faint p-4">No card statement lands a due in this month.</p>
          )}
        </div>
        <p className="text-xs text-ink-faint mt-2">
          Assumes this month&apos;s dues are paid this month. These are the bills that carry over.
        </p>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
          One-offs — only in {monthName.split(" ")[0]}
        </h2>
        <div className="border border-rule bg-paper-raised overflow-x-auto">
          <table className="ledger-grid w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="px-2 py-2 font-medium w-32">Date</th>
                <th className="px-2 py-2 font-medium">Title</th>
                <th className="px-2 py-2 font-medium w-64">Account</th>
                <th className="px-2 py-2 font-medium w-28 text-right">Amount</th>
                <th className="w-16"></th>
              </tr>
            </thead>
            <tbody>
              <OneOffAddRow month={month} accounts={active} onCreate={addOneOff} />
              {oneOffs.map((x) => (
                <OneOffRow key={x.id + x.date + oneOffAmount(x)} txn={x} accounts={accounts}
                  active={active} amountPaise={oneOffAmount(x)}
                  onPatch={patchOneOff} onDelete={() => removeOneOff(x)} />
              ))}
            </tbody>
          </table>
          {oneOffs.length === 0 && (
            <p className="text-sm text-ink-faint p-3">
              Nothing planned yet — a premium, a trip, a bonus. Added items show
              up in the Book as pending when the month arrives.
            </p>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint font-sans font-medium">
            Every month
          </h2>
          <button onClick={() => { setEditing(null); setFormOpen(true); }}
            className="flex items-center gap-1 text-xs border border-ledger text-ledger px-2 py-1 hover:bg-ledger-soft">
            <Plus size={12} /> recurring
          </button>
        </div>
        <div className="border border-rule bg-paper-raised overflow-x-auto">
          <table className="ledger-grid w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="px-3 py-2 font-medium w-10">Day</th>
                <th className="px-2 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium text-right w-28">Amount</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => {
                const from = accountById(accounts, t.from_account_id);
                const to = accountById(accounts, t.to_account_id);
                const income = isIncome(t);
                const internal = isInternal(t);
                return (
                  <tr key={t.id}>
                    <td className="px-3 py-1.5 amount text-ink-faint text-right">{t.day_of_month}</td>
                    <td className="px-2 py-1.5">
                      {t.name}
                      <span className="text-xs text-ink-faint"> · {from?.name}{internal ? " ⇄ " : " → "}{to?.name}</span>
                      {t.reimburse_account_id && t.reimburse_amount_paise ? (
                        <span className="text-[11px] text-ledger"> · {accountById(accounts, t.reimburse_account_id)?.name} returns {formatPaise(t.reimburse_amount_paise)}</span>
                      ) : null}
                      {t.total_installments ? (
                        <span className="text-[11px] text-ink-faint"> · installment {Math.min((doneCounts.get(t.id) ?? 0) + 1, t.total_installments)}/{t.total_installments}</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Amount paise={income ? t.amount_paise : -t.amount_paise} signed={!internal}
                        className={internal ? "text-ink-faint" : ""} />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => { setEditing(t); setFormOpen(true); }}
                        title={`Edit ${t.name}`} aria-label={`Edit ${t.name}`}
                        className="text-ink-faint hover:text-ledger p-0.5">
                        <Pencil size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-faint mt-2">
          Budgets and salary are fixed — the same every month. Pencil edits an
          item; posting and paying happen in the Book.
        </p>
      </section>

      <Modal open={leftOpen} title={`How "left" is calculated for ${monthName}`} onClose={() => setLeftOpen(false)}>
        <div className="text-sm space-y-2">
          <CalcLine label={`Salary + income templates${oneOffIn ? " + one-off income" : ""}`} paise={plannedIn} sign="+" />
          <CalcLine label="Cash committed — recurring paid from banks/cash + budgets + one-off spends" paise={committed} sign="−" />
          <CalcLine label="Card dues landing this month — carry-over bills from the previous cycle" paise={cardDue} sign="−" />
          <CalcLine label="Coming back — expected repayments" paise={expectedBack} sign="+" />
          <div className="border-t border-rule-strong pt-2">
            <CalcLine label="Left" paise={left} sign="=" bold />
          </div>
          <p className="text-xs text-ink-faint pt-1">
            Assumes this month&apos;s card dues are paid this month. Card swipes
            during the plan month that bill later belong to the month after —
            they&apos;ll show when you plan it.
          </p>
        </div>
      </Modal>

      <TemplateModal
        open={formOpen}
        accounts={active}
        editing={editing}
        onSaved={() => {
          setFormOpen(false);
          setEditing(null);
          load();
        }}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      />
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

function CalcLine({
  label, paise, sign, bold,
}: {
  label: string;
  paise: number;
  sign: string;
  bold?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${bold ? "font-medium" : ""}`}>
      <p className={bold ? "" : "text-ink-soft"}>{sign} {label}</p>
      <p className="amount whitespace-nowrap">{formatPaise(paise)}</p>
    </div>
  );
}

function OneOffAddRow({
  month, accounts, onCreate,
}: {
  month: string;
  accounts: Account[];
  onCreate: (e: EntryInput) => Promise<boolean>;
}) {
  const [date, setDate] = useState(`${month}-01`);
  const [dateEdit, setDateEdit] = useState(false);
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");

  useEffect(() => setDate(`${month}-01`), [month]);

  const fromChoices = accounts.filter((a) =>
    ["bank", "envelope", "cash", "investment", "credit_card", "receivable", "salary", "other_income"].includes(a.subtype)
  );
  const toChoices = accounts.filter((a) =>
    !["salary", "other_income", "opening_balance"].includes(a.subtype)
  );

  async function submit() {
    const paise = parseRupees(amount);
    if (!desc.trim() || !fromId || !toId || !paise || paise <= 0) return;
    const ok = await onCreate({
      date,
      description: desc.trim(),
      status: "pending",
      fromAccountId: fromId,
      toAccountId: toId,
      amountPaise: paise,
    });
    if (ok) {
      setDesc("");
      setAmount("");
    }
  }

  return (
    <tr className="bg-ledger-soft/50" onKeyDown={(e) => e.key === "Enter" && submit()}>
      <td>
        {dateEdit ? (
          <input type="date" value={date} autoFocus
            onChange={(e) => setDate(e.target.value)}
            onBlur={() => setDateEdit(false)}
            className="amount" />
        ) : (
          <button onClick={() => setDateEdit(true)}
            className="amount px-2 py-1.5 w-full text-left whitespace-nowrap hover:text-ledger">
            {fmtDate(date)}
          </button>
        )}
      </td>
      <td><input value={desc} onChange={(e) => setDesc(e.target.value)}
        placeholder="Plan a one-off… (Enter saves)" /></td>
      <td>
        <div className="flex items-center">
          <AccountSelect value={fromId} onChange={setFromId} choices={fromChoices}
            placeholder="from…" className="w-1/2" />
          <span className="text-ink-faint text-xs">→</span>
          <AccountSelect value={toId} onChange={setToId} choices={toChoices}
            placeholder="to…" className="w-1/2" />
        </div>
      </td>
      <td><input value={amount} onChange={(e) => setAmount(e.target.value)}
        placeholder="₹" inputMode="decimal" className="text-right amount" /></td>
      <td className="text-right">
        <button onClick={submit} className="text-ledger text-xs font-medium px-2 py-1.5 hover:underline">
          Add ↵
        </button>
      </td>
    </tr>
  );
}

function OneOffRow({
  txn, accounts, active, amountPaise, onPatch, onDelete,
}: {
  txn: Txn;
  accounts: Account[];
  active: Account[];
  amountPaise: number;
  onPatch: (x: Txn, patch: Partial<EntryInput>) => void;
  onDelete: () => void;
}) {
  const neg = txn.postings.find((p) => p.amount_paise < 0);
  const pos = txn.postings.find(
    (p) => p.amount_paise > 0 && p.account_id !== txn.reimburse_account_id
  );
  const from = neg ? accountById(accounts, neg.account_id) : undefined;
  const to = pos ? accountById(accounts, pos.account_id) : undefined;
  const isIn = from?.kind === "income" || from?.subtype === "receivable";
  const isInternal = from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";

  const [desc, setDesc] = useState(txn.description);
  const [amount, setAmount] = useState(String(amountPaise / 100));
  const [amountFocus, setAmountFocus] = useState(false);
  const [dateEdit, setDateEdit] = useState(false);

  const fromChoices = active.filter((a) =>
    ["bank", "envelope", "cash", "investment", "credit_card", "receivable", "salary", "other_income"].includes(a.subtype)
  );
  const toChoices = active.filter((a) =>
    !["salary", "other_income", "opening_balance"].includes(a.subtype)
  );

  const amountDisplay = amountFocus
    ? amount
    : `${isInternal ? "" : isIn ? "+" : "−"}${formatPaise(amountPaise)}`;

  return (
    <tr className="bg-pending-soft/40">
      <td>
        {dateEdit ? (
          <input type="date" value={txn.date} autoFocus
            onChange={(e) => onPatch(txn, { date: e.target.value })}
            onBlur={() => setDateEdit(false)}
            className="amount" />
        ) : (
          <button onClick={() => setDateEdit(true)}
            className="amount text-ink-faint px-2 py-1.5 w-full text-left whitespace-nowrap hover:text-ink">
            {fmtDate(txn.date)}
          </button>
        )}
      </td>
      <td>
        <input value={desc} onChange={(e) => setDesc(e.target.value)}
          onBlur={() => desc.trim() && desc !== txn.description && onPatch(txn, { description: desc.trim() })} />
      </td>
      <td>
        <div className="flex items-center">
          <AccountSelect value={neg?.account_id ?? ""} choices={fromChoices} className="w-1/2 text-xs"
            onChange={(v) => v && onPatch(txn, { fromAccountId: v })} />
          <span className="text-ink-faint text-xs">{isInternal ? "⇄" : "→"}</span>
          <AccountSelect value={pos?.account_id ?? ""} choices={toChoices} className="w-1/2 text-xs"
            onChange={(v) => v && onPatch(txn, { toAccountId: v })} />
        </div>
      </td>
      <td>
        <input value={amountDisplay} inputMode="decimal"
          onFocus={() => {
            setAmount(String(amountPaise / 100));
            setAmountFocus(true);
          }}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => {
            setAmountFocus(false);
            const p = parseRupees(amount);
            if (p && p > 0 && p !== amountPaise) onPatch(txn, { amountPaise: p });
          }}
          className={`text-right amount ${isIn ? "text-ledger" : isInternal ? "text-ink-faint" : "text-debit"}`} />
      </td>
      <td className="px-2 py-1.5 text-right">
        <button onClick={onDelete} className="text-ink-faint hover:text-debit">×</button>
      </td>
    </tr>
  );
}

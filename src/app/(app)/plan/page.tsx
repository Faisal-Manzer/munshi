"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { Amount } from "@/components/amount";
import { Headline } from "@/components/headline";
import { SideBlock } from "@/components/side-block";
import { Select } from "@/components/select";
import { amountMatches } from "@/lib/search";
import { AccountSelect, accountGroups } from "@/components/account-select";
import { Modal } from "@/components/modal";
import { TemplateModal } from "@/components/template-form";
import { TitleInput, useTitleSuggestions } from "@/components/title-input";
import { DateInput } from "@/components/date-input";
import { createEntry, rewriteEntry, type EntryInput } from "@/lib/postings";
import { formatPaise, parseRupees } from "@/lib/money";
import { toISODate } from "@/lib/ledger";
import { emiInfo, fmtMonth } from "@/lib/emi";
import {
  isIncomeTemplate,
  isInternalTemplate,
  liquidNowOf,
  monthPlan,
  oneOffAmount,
  oneOffsFor,
  projectedLiquidThrough,
  type PlanContext,
  type Txn,
} from "@/lib/calc";
import { Pencil, Plus, Search, X } from "lucide-react";
import type { Account, RecurringTemplate } from "@/lib/types";

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

export default function PlanPage() {
  const { supabase, ledgerId, accounts, balances, cycles, loading, reload } = useLedger();
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [allOneOffs, setAllOneOffs] = useState<Txn[]>([]);
  const [doneCounts, setDoneCounts] = useState<Map<string, number>>(new Map());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringTemplate | null>(null);
  const [leftOpen, setLeftOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [fAcct, setFAcct] = useState("");
  const [fTag, setFTag] = useState("");
  const [fKind, setFKind] = useState("");

  const today = new Date();
  // plan is for NEXT month by default — this month is assumed to resolve itself
  const nextMonth = toISODate(new Date(today.getFullYear(), today.getMonth() + 1, 1)).slice(0, 7);
  const [month, setMonth] = useState(nextMonth);

  const load = useCallback(async () => {
    if (!ledgerId) return;
    // pending one-offs from next month through the viewed month — the whole
    // stretch feeds the projected-liquid accumulation, not just the viewed month
    const start = `${nextMonth}-01`;
    const end = toISODate(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    const [tRes, oRes, cRes] = await Promise.all([
      supabase
        .from("recurring_templates")
        .select("*")
        .eq("ledger_id", ledgerId)
        .eq("active", true)
        .order("day_of_month"),
      supabase
        .from("transactions")
        .select("*, postings(*)")
        .eq("ledger_id", ledgerId)
        .is("recurring_template_id", null)
        .eq("status", "pending")
        .gte("date", start)
        .lt("date", end)
        .order("date"),
      supabase
        .from("transactions")
        .select("recurring_template_id")
        .eq("ledger_id", ledgerId)
        .not("recurring_template_id", "is", null)
        .eq("status", "done"),
    ]);
    if (tRes.error || oRes.error) {
      setError(tRes.error?.message ?? oRes.error?.message ?? "load failed");
      return;
    }
    setTemplates(tRes.data as RecurringTemplate[]);
    setAllOneOffs(oRes.data as Txn[]);
    const counts = new Map<string, number>();
    for (const r of (cRes.data ?? []) as { recurring_template_id: string }[]) {
      counts.set(r.recurring_template_id, (counts.get(r.recurring_template_id) ?? 0) + 1);
    }
    setDoneCounts(counts);
  }, [supabase, ledgerId, month, nextMonth]);

  useEffect(() => {
    load();
  }, [load]);

  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  const isIncome = (t: RecurringTemplate) => isIncomeTemplate(accounts, t);
  const isInternal = (t: RecurringTemplate) => isInternalTemplate(accounts, t);

  // ---- per-month plan math lives in lib/calc — the viewed month and the
  // projection share one brain, and it's unit-tested there
  const ctx: PlanContext = { accounts, active, templates, allOneOffs, cycles, today };

  const oneOffs = oneOffsFor(allOneOffs, month);
  const { plannedIn, committed, expectedBack, cardPlans, cardDue, left } = monthPlan(ctx, month);

  // ---- projected liquid: what's liquid today + every month's left through the viewed month
  const liquidNow = liquidNowOf(active, balances);
  const projectedLiquid = projectedLiquidThrough(ctx, liquidNow, nextMonth, month);

  // ---- one-off actions
  async function addOneOff(e: Omit<EntryInput, "ledgerId">) {
    try {
      await createEntry(supabase, { ...e, ledgerId: ledgerId!, status: "pending" });
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

  // ---- filters over the unified plan table (display only; math sees all)
  const knownTags = useMemo(
    () => [...new Set(allOneOffs.map((x) => x.tag).filter(Boolean))] as string[],
    [allOneOffs]
  );
  const filtering = !!(query.trim() || fAcct || fTag || fKind);

  function tplMatches(t: RecurringTemplate): boolean {
    if (fKind === "oneoff") return false;
    if (fTag) return false; // recurring items carry no tag
    if (fAcct && ![t.from_account_id, t.to_account_id, t.reimburse_account_id].includes(fAcct)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (amountMatches(q, t.amount_paise)) return true;
    return [
      t.name, t.notes ?? "",
      accountById(accounts, t.from_account_id)?.name ?? "",
      accountById(accounts, t.to_account_id)?.name ?? "",
    ].join(" ").toLowerCase().includes(q);
  }

  function oneOffMatches(x: Txn): boolean {
    if (fKind === "recurring") return false;
    if (fTag && (x.tag ?? "") !== fTag) return false;
    if (fAcct && !x.postings.some((p) => p.account_id === fAcct)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (amountMatches(q, oneOffAmount(x))) return true;
    const names = x.postings.map((p) => accountById(accounts, p.account_id)?.name ?? "").join(" ");
    return `${x.description} ${x.notes ?? ""} ${x.tag ?? ""} ${names}`.toLowerCase().includes(q);
  }

  // one table: one-offs and recurring interleaved by day of month
  const planRows = [
    ...oneOffs.filter(oneOffMatches).map((x) => ({
      day: Number(x.date.slice(8, 10)), oneoff: x as Txn | null, tpl: null as RecurringTemplate | null,
    })),
    ...templates.filter(tplMatches).map((t) => ({
      day: t.day_of_month, oneoff: null as Txn | null, tpl: t as RecurringTemplate | null,
    })),
  ].sort((a, b) => a.day - b.day || (a.oneoff ? 1 : 0) - (b.oneoff ? 1 : 0));
  const totalRows = oneOffs.length + templates.length;

  function shiftMonth(delta: number) {
    const [y, m] = month.split("-").map(Number);
    const next = toISODate(new Date(y, m - 1 + delta, 1)).slice(0, 7);
    if (next < nextMonth) return; // Plan is future-only — the Book owns now and the past
    setMonth(next);
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>;

  const monthName = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => shiftMonth(-1)} disabled={month <= nextMonth}
            className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft disabled:opacity-30 disabled:hover:bg-transparent">←</button>
          <h1 className="text-3xl w-[250px] text-center whitespace-nowrap">{monthName}</h1>
          <button onClick={() => shiftMonth(1)} className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft">→</button>
          {month !== nextMonth && (
            <button onClick={() => setMonth(nextMonth)}
              className="text-xs text-ink-faint hover:text-ledger underline decoration-dotted">
              back to next month
            </button>
          )}
        </div>
        <p className="text-sm text-ink-soft text-right">
          Liquid today <span className="amount">{formatPaise(liquidNow)}</span>
          {" → by end of "}{monthName.split(" ")[0]}:{" "}
          <span className={`amount ${projectedLiquid >= 0 ? "text-ledger" : "text-debit"}`}>
            {formatPaise(projectedLiquid)}
          </span>
          <br />
          <span className="text-xs text-ink-faint">liquid accounts + each month&apos;s left from {fmtMonth(nextMonth + "-01")} on; ad-hoc spends not included</span>
        </p>
      </div>

      {error && <p className="text-sm text-debit border border-debit-soft bg-debit-soft px-3 py-2">{error}</p>}

      {/* filter band — filters left, headline numbers right, same as the Book */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 border border-rule bg-paper-raised px-2 py-1">
          <Search size={13} className="text-ink-faint shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plan…"
            className="text-sm bg-transparent w-44" />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search"
              className="text-ink-faint hover:text-ink"><X size={12} /></button>
          )}
        </div>
        <Select chrome value={fAcct} onChange={setFAcct} placeholder="Any account" className="w-44"
          groups={[{ options: [{ value: "", label: "Any account" }] }, ...accountGroups(active)]} />
        <Select chrome value={fTag} onChange={setFTag} placeholder="Any tag" className="w-32"
          groups={[{ options: [{ value: "", label: "Any tag" },
            ...knownTags.map((t) => ({ value: t, label: t }))] }]} />
        <Select chrome value={fKind} onChange={setFKind} placeholder="Any kind" className="w-32"
          groups={[{ options: [
            { value: "", label: "Any kind" },
            { value: "recurring", label: "Recurring" },
            { value: "oneoff", label: "One-offs" },
          ] }]} />
          {filtering && (
            <button onClick={() => { setQuery(""); setFAcct(""); setFTag(""); setFKind(""); }}
              className="flex items-center gap-1 text-xs text-ink-soft hover:text-debit">
              <X size={12} /> {planRows.length} of {totalRows} — clear
            </button>
          )}
        </div>
        <div className="flex gap-6 text-sm flex-wrap">
          <Headline label="coming in" paise={plannedIn} cls="text-ledger" incoming={plannedIn > 0} />
          <Headline label="cash committed" paise={committed} />
          <Headline label="card dues landing" paise={cardDue > 0 ? -cardDue : 0} cls={cardDue > 0 ? "text-debit" : ""} />
          <Headline label="coming back" paise={expectedBack} cls="text-ledger" incoming={expectedBack > 0} />
          <button onClick={() => setLeftOpen(true)} title="How is this calculated?" className="text-right">
            <Headline label="projected savings ⓘ" paise={left} cls={left >= 0 ? "text-ledger" : "text-debit"} />
          </button>
        </div>
      </div>

      <div className="grid xl:grid-cols-[1fr_310px] gap-5 items-start">
        {/* unified plan table — one-offs and every-month together */}
        <section>
          <div className="border border-rule bg-paper-raised overflow-x-auto">
            <table className="ledger-grid w-full text-sm min-w-[540px] md:min-w-[860px]">
              <thead>
                <tr className="text-left text-xs text-ink-faint">
                  <th className="px-2 py-2 font-medium w-32">Date</th>
                  <th className="px-2 py-2 font-medium">Title</th>
                  <th className="px-2 py-2 font-medium w-56">Account</th>
                  <th className="px-2 py-2 font-medium w-36 text-right">Amount</th>
                  <th className="px-2 py-2 font-medium w-28">Tag</th>
                  <th className="px-2 py-2 font-medium w-40">Note</th>
                  <th className="w-24 text-right pr-2 font-medium">
                    <button onClick={() => { setEditing(null); setFormOpen(true); }}
                      title="New recurring item — repeats every month"
                      aria-label="New recurring item"
                      className="inline-flex items-center gap-0.5 text-ledger hover:bg-ledger-soft px-1 py-0.5 font-medium">
                      <Plus size={12} /> recurring
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <OneOffAddRow month={month} accounts={active} onCreate={addOneOff} supabase={supabase} />
                {planRows.map((r) => {
                  if (r.oneoff) {
                    const x = r.oneoff;
                    return (
                      <OneOffRow key={x.id + x.date + oneOffAmount(x)} txn={x} accounts={accounts}
                        active={active} amountPaise={oneOffAmount(x)}
                        onPatch={patchOneOff} onDelete={() => removeOneOff(x)} />
                    );
                  }
                  const t = r.tpl!;
                  const from = accountById(accounts, t.from_account_id);
                  const to = accountById(accounts, t.to_account_id);
                  const income = isIncome(t);
                  const internal = isInternal(t);
                  const emi = emiInfo(t, month);
                  const inactive = emi ? emi.idx < 1 || emi.idx > emi.total : false;
                  return (
                    <tr key={t.id} className={inactive ? "opacity-45" : ""}>
                      <td className="px-2 py-1.5 amount text-ink-faint whitespace-nowrap">
                        every {ordinal(t.day_of_month)}
                      </td>
                      <td className="px-2 py-1.5">
                        {t.name}
                        {emi && inactive && (
                          <span className="text-[11px] text-ink-faint">
                            {" "}· {emi.idx > emi.total ? `ended ${fmtMonth(emi.endISO)}` : `starts ${fmtMonth(emi.startISO)}`} — not counted
                          </span>
                        )}
                      </td>
                      <td className="px-0 py-2 text-xs text-ink-faint">
                        <div className="flex items-center">
                          <span className="w-1/2 px-2">{from?.name}</span>
                          <span>{internal ? "⇄" : "→"}</span>
                          <span className="w-1/2 px-2">{to?.name}</span>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Amount paise={income ? t.amount_paise : -t.amount_paise} signed={!internal}
                          className={internal ? "text-ink-faint" : ""} />
                      </td>
                      <td className="px-2 py-1.5"></td>
                      <td className="px-2 py-1.5 text-[11px]">
                        {t.reimburse_account_id && t.reimburse_amount_paise ? (
                          <span className="text-ledger">{accountById(accounts, t.reimburse_account_id)?.name} returns {formatPaise(t.reimburse_amount_paise)}</span>
                        ) : null}
                        {emi && !inactive ? (
                          <span className="text-ink-faint">{t.reimburse_account_id && t.reimburse_amount_paise ? " · " : ""}EMI {emi.idx}/{emi.total} · ends {fmtMonth(emi.endISO)}</span>
                        ) : t.total_installments && !emi ? (
                          <span className="text-ink-faint">{t.reimburse_account_id && t.reimburse_amount_paise ? " · " : ""}installment {Math.min((doneCounts.get(t.id) ?? 0) + 1, t.total_installments)}/{t.total_installments} · set first-installment date for progress</span>
                        ) : null}
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
            {planRows.length === 0 && (
              <p className="text-sm text-ink-faint p-3">
                {filtering
                  ? "Nothing matches these filters."
                  : "Nothing planned yet — a premium, a trip, a bonus. Added items show up in the Book as pending when the month arrives."}
              </p>
            )}
          </div>
          <p className="text-xs text-ink-faint mt-2">
            “every Nth” rows repeat monthly — the pencil edits them; dated rows
            are one-offs for this month only and edit inline. Posting and
            paying happen in the Book.
          </p>
        </section>

        {/* sidebar — same placement as the Book */}
        <aside className="space-y-2">
          <SideBlock title={`Card dues — ${monthName.split(" ")[0]}`}
            total={<Amount paise={cardDue > 0 ? -cardDue : 0}
              className={`px-3 ${cardDue > 0 ? "text-debit" : "text-ink-faint"}`} />}>
            {cardPlans.map((cp) => (
              <div key={cp.card.id} className="px-3 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm">{cp.card.name}</p>
                  <Amount paise={cp.total > 0 ? -cp.total : 0}
                    className={cp.total > 0 ? "text-debit" : "text-ink-faint"} />
                </div>
                <p className="text-[11px] text-ink-faint">
                  bills {fmtDate(toISODate(cp.stmtDate))} · due {fmtDate(toISODate(cp.dueDate))}
                </p>
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
              <p className="text-sm text-ink-faint px-3 py-2">No card statement lands a due in this month.</p>
            )}
          </SideBlock>
          <p className="text-xs text-ink-faint px-1">
            Assumes this month&apos;s dues are paid this month. These are the
            bills that carry over.
          </p>
        </aside>
      </div>

      <Modal open={leftOpen} title={`How projected savings is calculated for ${monthName}`} onClose={() => setLeftOpen(false)}>
        <div className="text-sm space-y-2">
          <CalcLine label="Salary + income templates + one-off income" paise={plannedIn} sign="+" />
          <CalcLine label="Cash committed — recurring paid from banks/cash + budgets + one-off spends" paise={committed} sign="−" />
          <CalcLine label="Card dues landing this month — carry-over bills from the previous cycle" paise={cardDue} sign="−" />
          <CalcLine label="Coming back — expected repayments" paise={expectedBack} sign="+" />
          <div className="border-t border-rule-strong pt-2">
            <CalcLine label="Projected savings" paise={left} sign="=" bold />
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

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
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
  month, accounts, onCreate, supabase,
}: {
  month: string;
  accounts: Account[];
  onCreate: (e: Omit<EntryInput, "ledgerId">) => Promise<boolean>;
  supabase: ReturnType<typeof useLedger>["supabase"];
}) {
  const [date, setDate] = useState(`${month}-01`);
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [tag, setTag] = useState("");
  const [note, setNote] = useState("");
  const suggestions = useTitleSuggestions(supabase);

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
      tag: tag.trim() || null,
      notes: note.trim() || null,
    });
    if (ok) {
      setDesc("");
      setAmount("");
      setTag("");
      setNote("");
    }
  }

  return (
    <tr className="bg-ledger-soft/50" onKeyDown={(e) => e.key === "Enter" && submit()}>
      <td>
        <DateInput value={date} onChange={setDate} />
      </td>
      <td>
        <TitleInput value={desc} onChange={setDesc} suggestions={suggestions}
          placeholder="Plan a one-off… (Enter saves)"
          onPick={(s) => {
            setDesc(s.title);
            if (!fromId && s.fromId) setFromId(s.fromId);
            if (!toId && s.toId) setToId(s.toId);
            if (!tag && s.tag) setTag(s.tag);
          }} />
      </td>
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
      <td><input value={tag} onChange={(e) => setTag(e.target.value)}
        placeholder="tag" className="text-xs" /></td>
      <td><input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="note" className="text-xs" /></td>
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
        <DateInput value={txn.date} onChange={(iso) => onPatch(txn, { date: iso })}
          className="text-ink-faint" />
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
      <td>
        <input defaultValue={txn.tag ?? ""} placeholder="—"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (txn.tag ?? "")) onPatch(txn, { tag: v || null });
          }}
          className={`text-xs ${txn.tag ? "text-pending" : "text-ink-faint"}`} />
      </td>
      <td>
        <input defaultValue={txn.notes ?? ""} placeholder="—"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (txn.notes ?? "")) onPatch(txn, { notes: v || null });
          }}
          className="text-xs text-ink-soft" />
      </td>
      <td className="px-2 py-1.5 text-right">
        <button onClick={onDelete} className="text-ink-faint hover:text-debit">×</button>
      </td>
    </tr>
  );
}

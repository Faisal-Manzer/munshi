"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { createEntry } from "@/lib/postings";
import { Amount } from "@/components/amount";
import { parseRupees } from "@/lib/money";
import { toISODate } from "@/lib/ledger";
import {
  RECURRING_KIND_LABEL,
  type Account,
  type RecurringKind,
  type RecurringTemplate,
  type Transaction,
} from "@/lib/types";

export default function RecurringPage() {
  const { supabase, accounts, loading, reload } = useLedger();
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [monthTxns, setMonthTxns] = useState<Transaction[]>([]);
  const [doneCounts, setDoneCounts] = useState<Map<string, number>>(new Map());
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<RecurringTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const month = toISODate(new Date()).slice(0, 7);
  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const people = active.filter((a) => a.subtype === "receivable");

  const load = useCallback(async () => {
    const start = `${month}-01`;
    const [tRes, xRes, cRes] = await Promise.all([
      supabase.from("recurring_templates").select("*").order("day_of_month"),
      supabase
        .from("transactions")
        .select("*")
        .not("recurring_template_id", "is", null)
        .gte("date", start),
      supabase
        .from("transactions")
        .select("recurring_template_id")
        .not("recurring_template_id", "is", null)
        .eq("status", "done"),
    ]);
    if (tRes.error) {
      setError(tRes.error.message);
      return;
    }
    setTemplates(tRes.data as RecurringTemplate[]);
    setMonthTxns((xRes.data ?? []) as Transaction[]);
    const counts = new Map<string, number>();
    for (const r of (cRes.data ?? []) as { recurring_template_id: string }[]) {
      counts.set(r.recurring_template_id, (counts.get(r.recurring_template_id) ?? 0) + 1);
    }
    setDoneCounts(counts);
  }, [supabase, month]);

  useEffect(() => {
    load();
  }, [load]);

  async function postForMonth(t: RecurringTemplate) {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(y, m, 0).getDate();
    const date = `${month}-${String(Math.min(t.day_of_month, last)).padStart(2, "0")}`;
    try {
      await createEntry(supabase, {
        date,
        description: t.name,
        status: "pending",
        fromAccountId: t.from_account_id,
        toAccountId: t.to_account_id,
        amountPaise: t.amount_paise,
        reimburseAccountId: t.reimburse_account_id,
        reimbursePaise: t.reimburse_amount_paise,
        recurringTemplateId: t.id,
      });
      setError(null);
      await Promise.all([load(), reload()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  }

  async function markDone(txn: Transaction) {
    await supabase.from("transactions").update({ status: "done" }).eq("id", txn.id);
    await Promise.all([load(), reload()]);
  }

  async function deactivate(t: RecurringTemplate) {
    if (!confirm(`Stop "${t.name}"? Past entries stay.`)) return;
    await supabase.from("recurring_templates").update({ active: false }).eq("id", t.id);
    load();
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>;

  const activeTemplates = templates.filter((t) => t.active);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Recurring &amp; EMIs</h1>
        <button onClick={() => setShowForm((v) => !v)}
          className="border border-ledger text-ledger px-3 py-1.5 text-sm hover:bg-ledger-soft">
          {showForm ? "Close" : "+ New recurring"}
        </button>
      </div>

      {error && <p className="text-sm text-debit">{error}</p>}

      {(showForm || editing) && (
        <TemplateForm
          key={editing?.id ?? "new"}
          accounts={active}
          people={people}
          editing={editing}
          onSaved={() => {
            setShowForm(false);
            setEditing(null);
            load();
          }}
        />
      )}

      <div className="border border-rule bg-paper-raised divide-y divide-rule">
        {activeTemplates.length === 0 && (
          <p className="text-sm text-ink-faint p-4">
            No recurring items yet. Add rent, EMIs, subscriptions — anything
            that repeats monthly.
          </p>
        )}
        {activeTemplates.map((t) => {
          const inst = monthTxns.find((x) => x.recurring_template_id === t.id);
          const from = accountById(accounts, t.from_account_id);
          const to = accountById(accounts, t.to_account_id);
          const person = accountById(accounts, t.reimburse_account_id);
          const done = doneCounts.get(t.id) ?? 0;
          return (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  {t.name}
                  <span className="text-ink-faint"> · {ordinal(t.day_of_month)} of month</span>
                </p>
                <p className="text-xs text-ink-faint">
                  {RECURRING_KIND_LABEL[t.kind]} · {from?.name} → {to?.name}
                  {person && t.reimburse_amount_paise
                    ? ` · ${person.name} repays ₹${(t.reimburse_amount_paise / 100).toLocaleString("en-IN")}${t.reimburse_expected_day ? ` around ${ordinal(t.reimburse_expected_day)}` : ""}`
                    : ""}
                  {t.total_installments
                    ? ` · installment ${Math.min(done + 1, t.total_installments)}/${t.total_installments}`
                    : ""}
                </p>
              </div>
              <Amount paise={t.amount_paise} />
              {!inst ? (
                <button onClick={() => postForMonth(t)}
                  className="text-xs border border-rule px-2 py-1 hover:bg-ledger-soft">
                  Post {month}
                </button>
              ) : inst.status === "pending" ? (
                <button onClick={() => markDone(inst)}
                  className="text-xs border border-pending text-pending bg-pending-soft px-2 py-1"
                  title={kindHint(t.kind)}>
                  pending — mark paid
                </button>
              ) : (
                <span className="text-xs text-ledger border border-ledger px-2 py-1">paid ✓</span>
              )}
              <button onClick={() => setEditing(t)} className="text-xs text-ink-faint hover:text-ledger">
                edit
              </button>
              <button onClick={() => deactivate(t)} className="text-xs text-ink-faint hover:text-debit">
                stop
              </button>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-ink-faint max-w-2xl">
        “Post” creates a pending ledger entry for this month; mark it paid once
        the debit actually happens. Auto-debits still need posting — the app
        never invents entries on its own.
      </p>
    </div>
  );
}

function TemplateForm({
  accounts, people, editing, onSaved,
}: {
  accounts: Account[];
  people: Account[];
  editing?: RecurringTemplate | null;
  onSaved: () => void;
}) {
  const { supabase } = useLedger();
  const [name, setName] = useState(editing?.name ?? "");
  const [kind, setKind] = useState<RecurringKind>(editing?.kind ?? "autodebit_bank");
  const [day, setDay] = useState(editing ? String(editing.day_of_month) : "5");
  const [amount, setAmount] = useState(editing ? String(editing.amount_paise / 100) : "");
  const [fromId, setFromId] = useState(editing?.from_account_id ?? "");
  const [toId, setToId] = useState(editing?.to_account_id ?? "");
  const [personId, setPersonId] = useState(editing?.reimburse_account_id ?? "");
  const [personAmt, setPersonAmt] = useState(
    editing?.reimburse_amount_paise ? String(editing.reimburse_amount_paise / 100) : ""
  );
  const [personDay, setPersonDay] = useState(
    editing?.reimburse_expected_day ? String(editing.reimburse_expected_day) : ""
  );
  const [installments, setInstallments] = useState(
    editing?.total_installments ? String(editing.total_installments) : ""
  );
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fromChoices = accounts.filter((a) =>
    ["bank", "cash", "investment", "credit_card", "envelope", "salary", "other_income"].includes(a.subtype)
  );
  const toChoices = accounts.filter((a) =>
    ["general_expense", "loan", "bank", "envelope", "receivable", "credit_card", "cash", "investment"].includes(a.subtype)
  );

  async function save() {
    const paise = parseRupees(amount);
    if (!name.trim() || !fromId || !toId || !paise) {
      setErr("Name, from, to and amount are required.");
      return;
    }
    setSaving(true);
    const row = {
      name: name.trim(),
      kind,
      day_of_month: Number(day),
      amount_paise: paise,
      from_account_id: fromId,
      to_account_id: toId,
      reimburse_account_id: personId || null,
      reimburse_amount_paise: personId ? parseRupees(personAmt) : null,
      reimburse_expected_day: personId && personDay ? Number(personDay) : null,
      total_installments: installments ? Number(installments) : null,
    };
    const { error } = editing
      ? await supabase.from("recurring_templates").update(row).eq("id", editing.id)
      : await supabase.from("recurring_templates").insert(row);
    setSaving(false);
    if (error) {
      setErr(error.message);
      return;
    }
    onSaved();
  }

  const input = "border border-rule px-2 py-1.5 text-sm bg-paper-raised";
  return (
    <div className="border border-rule bg-paper-raised p-4 grid gap-3 sm:grid-cols-2">
      <input className={input} value={name} onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. Business EMI, Rent)" />
      <select className={input} value={kind} onChange={(e) => setKind(e.target.value as RecurringKind)}>
        {Object.entries(RECURRING_KIND_LABEL).map(([k, label]) => (
          <option key={k} value={k}>{label}</option>
        ))}
      </select>
      <input className={input} value={day} onChange={(e) => setDay(e.target.value)}
        placeholder="Day of month (1–31)" inputMode="numeric" />
      <input className={input} value={amount} onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount ₹" inputMode="decimal" />
      <select className={input} value={fromId} onChange={(e) => setFromId(e.target.value)}>
        <option value="">Paid from…</option>
        {fromChoices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select className={input} value={toId} onChange={(e) => setToId(e.target.value)}>
        <option value="">Pays for… (expense / loan)</option>
        {toChoices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <input className={input} value={installments} onChange={(e) => setInstallments(e.target.value)}
        placeholder="Total installments (EMIs, optional)" inputMode="numeric" />
      <select className={input} value={personId} onChange={(e) => setPersonId(e.target.value)}>
        <option value="">Someone repays part? (optional)</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {personId && (
        <>
          <input className={input} value={personAmt} onChange={(e) => setPersonAmt(e.target.value)}
            placeholder="Their share ₹" inputMode="decimal" />
          <input className={input} value={personDay} onChange={(e) => setPersonDay(e.target.value)}
            placeholder="Expected repay day (1–31)" inputMode="numeric" />
        </>
      )}
      {err && <p className="text-sm text-debit sm:col-span-2">{err}</p>}
      <button onClick={save} disabled={saving}
        className="bg-ledger text-paper-raised px-3 py-1.5 text-sm sm:col-span-2 disabled:opacity-60">
        {saving ? "Saving…" : editing ? `Update “${editing.name}”` : "Save recurring item"}
      </button>
    </div>
  );
}

function kindHint(k: RecurringKind): string {
  switch (k) {
    case "autodebit_bank":
      return "Auto-debits from bank — make sure the balance is there";
    case "autodebit_cc":
      return "Auto-charges the card statement";
    case "manual":
      return "You pay this by hand";
    case "pay_before_due":
      return "Pay any time before the due date";
  }
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

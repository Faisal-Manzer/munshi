"use client";

import { useState } from "react";
import { useLedger } from "@/lib/use-ledger";
import { Modal } from "@/components/modal";
import { Select } from "@/components/select";
import { accountGroups } from "@/components/account-select";
import { parseRupees } from "@/lib/money";
import {
  RECURRING_KIND_LABEL,
  type Account,
  type RecurringKind,
  type RecurringTemplate,
} from "@/lib/types";

/** Create/edit a recurring template in a modal. Pass `editing` to edit; null = new. */
export function TemplateModal({
  open, accounts, editing, onSaved, onClose,
}: {
  open: boolean;
  accounts: Account[];
  editing: RecurringTemplate | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} wide onClose={onClose}
      title={editing ? `Edit "${editing.name}"` : "New recurring item"}>
      <TemplateForm key={editing?.id ?? "new"} accounts={accounts} editing={editing}
        onSaved={onSaved} />
    </Modal>
  );
}

function TemplateForm({
  accounts, editing, onSaved,
}: {
  accounts: Account[];
  editing: RecurringTemplate | null;
  onSaved: () => void;
}) {
  const { supabase } = useLedger();
  const people = accounts.filter((a) => a.subtype === "receivable");
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
  const [isBudget, setIsBudget] = useState(editing?.is_budget ?? false);
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
      is_budget: isBudget,
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

  async function stop() {
    if (!editing) return;
    if (!confirm(`Stop "${editing.name}"? Past entries stay.`)) return;
    setSaving(true);
    const { error } = await supabase
      .from("recurring_templates")
      .update({ active: false })
      .eq("id", editing.id);
    setSaving(false);
    if (error) {
      setErr(error.message);
      return;
    }
    onSaved();
  }

  const input = "border border-rule px-2 py-1.5 text-sm bg-paper-raised";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <input className={input} value={name} onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. Business EMI, Rent)" />
      <Select chrome value={kind} onChange={(v) => setKind(v as RecurringKind)}
        groups={[{ options: Object.entries(RECURRING_KIND_LABEL).map(([k, label]) => ({ value: k, label })) }]} />
      <input className={input} value={day} onChange={(e) => setDay(e.target.value)}
        placeholder="Day of month (1–31)" inputMode="numeric" />
      <input className={input} value={amount} onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount ₹" inputMode="decimal" />
      <Select chrome value={fromId} onChange={setFromId} placeholder="Paid from…"
        groups={accountGroups(fromChoices)} />
      <Select chrome value={toId} onChange={setToId} placeholder="Pays for… (expense / loan)"
        groups={accountGroups(toChoices)} />
      <input className={input} value={installments} onChange={(e) => setInstallments(e.target.value)}
        placeholder="Total installments (EMIs, optional)" inputMode="numeric" />
      <Select chrome value={personId} onChange={setPersonId} placeholder="Someone repays part? (optional)"
        groups={[{ options: [{ value: "", label: "No one repays" },
          ...people.map((p) => ({ value: p.id, label: p.name }))] }]} />
      {personId && (
        <>
          <input className={input} value={personAmt} onChange={(e) => setPersonAmt(e.target.value)}
            placeholder="Their share ₹" inputMode="decimal" />
          <input className={input} value={personDay} onChange={(e) => setPersonDay(e.target.value)}
            placeholder="Expected repay day (1–31)" inputMode="numeric" />
        </>
      )}
      <label className="flex items-center gap-2 text-sm text-ink-soft sm:col-span-2">
        <input type="checkbox" checked={isBudget} onChange={(e) => setIsBudget(e.target.checked)} />
        Spending budget — a transfer to another account that still counts as
        committed spend (e.g. Home, personal allowance)
      </label>
      {err && <p className="text-sm text-debit sm:col-span-2">{err}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <button onClick={save} disabled={saving}
          className="flex-1 bg-ledger text-paper-raised px-3 py-1.5 text-sm disabled:opacity-60">
          {saving ? "Saving…" : editing ? "Update" : "Save recurring item"}
        </button>
        {editing && (
          <button onClick={stop} disabled={saving}
            className="border border-debit text-debit px-3 py-1.5 text-sm hover:bg-debit-soft disabled:opacity-60">
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

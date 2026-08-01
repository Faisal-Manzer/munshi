"use client";

import { useState } from "react";
import { useLedger } from "@/lib/use-ledger";
import { Modal } from "@/components/modal";
import { parseRupees } from "@/lib/money";
import { toISODate } from "@/lib/ledger";
import type { Account, AccountKind, AccountSubtype } from "@/lib/types";

export interface NewAccountOption {
  label: string;
  kind: AccountKind;
  subtype: AccountSubtype;
  needsParent?: "bank" | "credit_card";
}

export const NEW_OPTIONS: NewAccountOption[] = [
  { label: "Bank account", kind: "asset", subtype: "bank" },
  { label: "Envelope (money set aside)", kind: "asset", subtype: "envelope", needsParent: "bank" },
  { label: "Cash", kind: "asset", subtype: "cash" },
  { label: "Investment (Zerodha etc.)", kind: "asset", subtype: "investment" },
  { label: "Credit card", kind: "liability", subtype: "credit_card" },
  { label: "Sub-card (bills to parent card)", kind: "liability", subtype: "credit_card", needsParent: "credit_card" },
  { label: "Loan (you owe)", kind: "liability", subtype: "loan" },
  { label: "Person (owes you)", kind: "asset", subtype: "receivable" },
  { label: "Salary / income source", kind: "income", subtype: "salary" },
  { label: "Expense category", kind: "expense", subtype: "general_expense" },
];

/** Sidebar block → which NEW_OPTIONS it offers. */
export const BLOCK_OPTIONS: Record<string, number[]> = {
  accounts: [0, 1, 2],
  cards: [4, 5],
  investments: [3],
  loans: [6],
};

/** Create a new account (option list scoped by `optionIdxs`) or edit/archive an existing one. */
export function AccountModal({
  open, editing, optionIdxs, onDone, onClose,
}: {
  open: boolean;
  editing: Account | null;
  optionIdxs?: number[];
  onDone: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { supabase, accounts } = useLedger();
  const options = (optionIdxs ?? NEW_OPTIONS.map((_, i) => i)).map((i) => NEW_OPTIONS[i]);
  const [optIdx, setOptIdx] = useState(0);
  const opt = editing ? null : options[Math.min(optIdx, options.length - 1)];

  const [name, setName] = useState(editing?.name ?? "");
  const [parentId, setParentId] = useState(editing?.parent_id ?? "");
  const [stmtDay, setStmtDay] = useState(editing?.statement_day ? String(editing.statement_day) : "");
  const [dueDay, setDueDay] = useState(editing?.due_day ? String(editing.due_day) : "");
  const [limit, setLimit] = useState(
    editing?.credit_limit_paise ? String(editing.credit_limit_paise / 100) : ""
  );
  const [opening, setOpening] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const active = accounts.filter((a) => !a.archived);
  const isCard = editing
    ? editing.subtype === "credit_card" && editing.parent_id === null
    : opt?.subtype === "credit_card" && !opt.needsParent;
  const parentChoices = opt?.needsParent
    ? active.filter((a) =>
        opt.needsParent === "bank"
          ? a.subtype === "bank"
          : a.subtype === "credit_card" && a.parent_id === null
      )
    : [];

  async function save() {
    if (!name.trim()) return;
    setErr(null);
    setSaving(true);
    if (editing) {
      const { error } = await supabase
        .from("accounts")
        .update({
          name: name.trim(),
          statement_day: stmtDay ? Number(stmtDay) : null,
          due_day: dueDay ? Number(dueDay) : null,
          credit_limit_paise: parseRupees(limit),
        })
        .eq("id", editing.id);
      setSaving(false);
      if (error) {
        setErr(error.message);
        return;
      }
      await onDone();
      onClose();
      return;
    }

    if (!opt) return;
    if (opt.needsParent && !parentId) {
      setErr("Pick a parent account.");
      setSaving(false);
      return;
    }
    const { data: acc, error: e1 } = await supabase
      .from("accounts")
      .insert({
        name: name.trim(),
        kind: opt.kind,
        subtype: opt.subtype,
        parent_id: opt.needsParent ? parentId : null,
        due_day: dueDay ? Number(dueDay) : null,
        statement_day: stmtDay ? Number(stmtDay) : null,
        credit_limit_paise: parseRupees(limit),
        person_name: opt.subtype === "receivable" ? name.trim() : null,
      })
      .select()
      .single();
    if (e1) {
      setErr(e1.message);
      setSaving(false);
      return;
    }

    // opening balance via equity so books stay balanced
    const openingPaise = parseRupees(opening);
    if (openingPaise) {
      let equity = accounts.find((a) => a.subtype === "opening_balance");
      if (!equity) {
        const { data: eq } = await supabase
          .from("accounts")
          .insert({ name: "Opening balances", kind: "equity", subtype: "opening_balance" })
          .select()
          .single();
        equity = eq as Account;
      }
      const sign = opt.kind === "liability" ? -1 : 1;
      const { data: txn } = await supabase
        .from("transactions")
        .insert({
          date: toISODate(new Date()),
          description: `Opening balance — ${name.trim()}`,
          status: "done",
        })
        .select()
        .single();
      if (txn && equity) {
        await supabase.from("postings").insert([
          { transaction_id: txn.id, account_id: acc.id, amount_paise: sign * openingPaise },
          { transaction_id: txn.id, account_id: equity.id, amount_paise: -sign * openingPaise },
        ]);
      }
    }
    setSaving(false);
    await onDone();
    onClose();
  }

  async function archive() {
    if (!editing) return;
    if (!confirm(`Archive ${editing.name}? It stays in history but hides from lists.`)) return;
    const { error } = await supabase
      .from("accounts")
      .update({ archived: true })
      .eq("id", editing.id);
    if (error) {
      setErr(error.message);
      return;
    }
    await onDone();
    onClose();
  }

  const input = "border border-rule px-2 py-1.5 text-sm bg-paper-raised w-full";
  const canOpen = opt && ["bank", "cash", "loan", "credit_card", "receivable", "investment"].includes(opt.subtype);

  return (
    <Modal open={open} title={editing ? `Edit ${editing.name}` : "New account"} onClose={onClose}>
      <div className="space-y-3">
        {!editing && options.length > 1 && (
          <select className={input} value={optIdx} onChange={(e) => setOptIdx(Number(e.target.value))}>
            {options.map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
          </select>
        )}
        {!editing && options.length === 1 && (
          <p className="text-xs text-ink-faint">{options[0].label}</p>
        )}
        <input className={input} value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Name" autoFocus
          onKeyDown={(e) => e.key === "Enter" && save()} />
        {!editing && opt?.needsParent && (
          <select className={input} value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Parent {opt.needsParent === "bank" ? "bank" : "card"}…</option>
            {parentChoices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {isCard && (
          <>
            <input className={input} value={stmtDay} onChange={(e) => setStmtDay(e.target.value)}
              placeholder="Statement day (1–31)" inputMode="numeric" />
            <input className={input} value={dueDay} onChange={(e) => setDueDay(e.target.value)}
              placeholder="Due day (1–31)" inputMode="numeric" />
            <input className={input} value={limit} onChange={(e) => setLimit(e.target.value)}
              placeholder="Credit limit ₹ (optional)" inputMode="decimal" />
          </>
        )}
        {!editing && canOpen && (
          <input className={input} value={opening} onChange={(e) => setOpening(e.target.value)}
            placeholder={opt?.kind === "liability" ? "Current outstanding ₹ (optional)" : "Current balance ₹ (optional)"}
            inputMode="decimal" />
        )}
        {err && <p className="text-sm text-debit">{err}</p>}
        <div className="flex gap-2">
          <button onClick={save} disabled={saving}
            className="flex-1 bg-ledger text-paper-raised px-3 py-1.5 text-sm disabled:opacity-60">
            {saving ? "Saving…" : editing ? "Update" : "Add account"}
          </button>
          {editing && (
            <button onClick={archive} disabled={saving}
              className="border border-debit text-debit px-3 py-1.5 text-sm hover:bg-debit-soft disabled:opacity-60">
              Archive
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

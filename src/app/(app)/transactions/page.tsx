"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger } from "@/lib/use-ledger";
import { createEntry, rewriteEntry, type EntryInput } from "@/lib/postings";
import { formatPaisePlain, parseRupees } from "@/lib/money";
import { toISODate } from "@/lib/ledger";
import type { Account, Posting, Transaction } from "@/lib/types";

interface Row {
  txn: Transaction;
  fromId: string;
  toId: string;
  amountPaise: number;
}

export default function TransactionsPage() {
  const { supabase, accounts, loading, reload: reloadBalances } = useLedger();
  const [rows, setRows] = useState<Row[]>([]);
  const [month, setMonth] = useState(() => toISODate(new Date()).slice(0, 7));
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(
    () => accounts.filter((a) => !a.archived),
    [accounts]
  );
  // From: where money/credit comes from. To: where it goes.
  const fromChoices = useMemo(
    () => active.filter((a) => ["bank", "envelope", "cash", "investment", "credit_card", "receivable", "salary", "other_income"].includes(a.subtype)),
    [active]
  );
  const toChoices = useMemo(
    () => active.filter((a) => !["salary", "other_income", "opening_balance"].includes(a.subtype)),
    [active]
  );
  const people = useMemo(
    () => active.filter((a) => a.subtype === "receivable"),
    [active]
  );

  const loadRows = useCallback(async () => {
    const start = `${month}-01`;
    const end = toISODate(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    const { data: txns, error: te } = await supabase
      .from("transactions")
      .select("*, postings(*)")
      .gte("date", start)
      .lt("date", end)
      .order("date", { ascending: false })
      .order("created_at", { ascending: false });
    if (te) {
      setError(te.message);
      return;
    }
    const parsed: Row[] = [];
    for (const t of txns as (Transaction & { postings: Posting[] })[]) {
      const negs = t.postings.filter((p) => p.amount_paise < 0);
      const poss = t.postings.filter((p) => p.amount_paise > 0);
      if (negs.length !== 1 || poss.length < 1) continue; // opening balances etc. shown read-only elsewhere
      const from = negs[0];
      const to =
        poss.find((p) => p.account_id !== t.reimburse_account_id) ?? poss[0];
      parsed.push({
        txn: t,
        fromId: from.account_id,
        toId: to.account_id,
        amountPaise: -from.amount_paise,
      });
    }
    setRows(parsed);
  }, [supabase, month]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  async function saveEdit(row: Row, patch: Partial<EntryInput>) {
    const e: EntryInput = {
      date: row.txn.date,
      description: row.txn.description,
      status: row.txn.status,
      fromAccountId: row.fromId,
      toAccountId: row.toId,
      amountPaise: row.amountPaise,
      reimburseAccountId: row.txn.reimburse_account_id,
      reimbursePaise: row.txn.reimburse_amount_paise,
      ...patch,
    };
    try {
      await rewriteEntry(supabase, row.txn.id, e);
      setError(null);
      await Promise.all([loadRows(), reloadBalances()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    }
  }

  async function toggleStatus(row: Row) {
    await supabase
      .from("transactions")
      .update({ status: row.txn.status === "done" ? "pending" : "done" })
      .eq("id", row.txn.id);
    await Promise.all([loadRows(), reloadBalances()]);
  }

  async function remove(row: Row) {
    if (!confirm(`Delete "${row.txn.description}"?`)) return;
    await supabase.from("transactions").delete().eq("id", row.txn.id);
    await Promise.all([loadRows(), reloadBalances()]);
  }

  function shiftMonth(delta: number) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(toISODate(d).slice(0, 7));
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-3xl">Transactions</h1>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => shiftMonth(-1)} className="border border-rule px-2 py-1 hover:bg-ledger-soft">←</button>
          <span className="amount">{month}</span>
          <button onClick={() => shiftMonth(1)} className="border border-rule px-2 py-1 hover:bg-ledger-soft">→</button>
        </div>
      </div>

      {error && <p className="text-sm text-debit border border-debit-soft bg-debit-soft px-3 py-2">{error}</p>}

      {active.length === 0 ? (
        <p className="text-sm text-ink-faint border border-dashed border-rule p-4">
          Create your bank accounts, cards and expense categories under
          Accounts first — then log entries here.
        </p>
      ) : (
        <div className="border border-rule bg-paper-raised overflow-x-auto">
          <table className="ledger-grid w-full text-sm min-w-[880px]">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="px-2 py-2 font-medium w-28">Date</th>
                <th className="px-2 py-2 font-medium">Description</th>
                <th className="px-2 py-2 font-medium w-44">From</th>
                <th className="px-2 py-2 font-medium w-44">To</th>
                <th className="px-2 py-2 font-medium w-28 text-right">Amount ₹</th>
                <th className="px-2 py-2 font-medium w-40">Split with</th>
                <th className="px-2 py-2 font-medium w-20">Status</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              <NewRow
                fromChoices={fromChoices}
                toChoices={toChoices}
                people={people}
                onCreate={async (e) => {
                  try {
                    await createEntry(supabase, e);
                    setError(null);
                    await Promise.all([loadRows(), reloadBalances()]);
                    return true;
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "create failed");
                    return false;
                  }
                }}
              />
              {rows.map((row) => (
                <EditRow
                  key={row.txn.id + row.txn.status + row.amountPaise}
                  row={row}
                  fromChoices={fromChoices}
                  toChoices={toChoices}
                  people={people}
                  onSave={saveEdit}
                  onToggle={() => toggleStatus(row)}
                  onDelete={() => remove(row)}
                />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="text-sm text-ink-faint p-4">No entries this month yet — add one in the top row.</p>
          )}
        </div>
      )}
      <p className="text-xs text-ink-faint">
        Every row is a balanced double entry: From is credited, To is debited.
        Transfers = bank → bank. Card spend = card → expense. Card payment =
        bank → card. Money someone owes you = pick them under “Split with”
        (their share) or set To = person (they owe the full amount).
      </p>
    </div>
  );
}

function AccountSelect({
  value, onChange, choices, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  choices: Account[];
  placeholder?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder ?? "—"}</option>
      {choices.map((a) => (
        <option key={a.id} value={a.id}>
          {a.parent_id ? "· " : ""}{a.name}
        </option>
      ))}
    </select>
  );
}

function NewRow({
  fromChoices, toChoices, people, onCreate,
}: {
  fromChoices: Account[];
  toChoices: Account[];
  people: Account[];
  onCreate: (e: EntryInput) => Promise<boolean>;
}) {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [desc, setDesc] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [splitId, setSplitId] = useState("");
  const [splitAmt, setSplitAmt] = useState("");

  async function submit() {
    const paise = parseRupees(amount);
    if (!desc.trim() || !fromId || !toId || !paise || paise <= 0) return;
    const splitPaise = splitId ? parseRupees(splitAmt) : null;
    const ok = await onCreate({
      date,
      description: desc.trim(),
      status: "done",
      fromAccountId: fromId,
      toAccountId: toId,
      amountPaise: paise,
      reimburseAccountId: splitId || null,
      reimbursePaise: splitPaise,
    });
    if (ok) {
      setDesc("");
      setAmount("");
      setSplitId("");
      setSplitAmt("");
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") submit();
  }

  return (
    <tr className="bg-ledger-soft/50" onKeyDown={onKey}>
      <td><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></td>
      <td><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="New entry… (Enter saves)" /></td>
      <td><AccountSelect value={fromId} onChange={setFromId} choices={fromChoices} placeholder="From…" /></td>
      <td><AccountSelect value={toId} onChange={setToId} choices={toChoices} placeholder="To…" /></td>
      <td><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="decimal" className="text-right amount" /></td>
      <td className="whitespace-nowrap">
        <div className="flex">
          <AccountSelect value={splitId} onChange={setSplitId} choices={people} placeholder="—" />
          {splitId && (
            <input value={splitAmt} onChange={(e) => setSplitAmt(e.target.value)}
              placeholder="their ₹" inputMode="decimal" className="text-right amount w-20" />
          )}
        </div>
      </td>
      <td>
        <button onClick={submit} className="text-ledger text-xs font-medium px-2 py-1.5 hover:underline">
          Add ↵
        </button>
      </td>
      <td></td>
    </tr>
  );
}

function EditRow({
  row, fromChoices, toChoices, people, onSave, onToggle, onDelete,
}: {
  row: Row;
  fromChoices: Account[];
  toChoices: Account[];
  people: Account[];
  onSave: (row: Row, patch: Partial<EntryInput>) => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [desc, setDesc] = useState(row.txn.description);
  const [amount, setAmount] = useState(formatPaisePlain(row.amountPaise).replace(/,/g, ""));
  const [splitAmt, setSplitAmt] = useState(
    row.txn.reimburse_amount_paise ? String(row.txn.reimburse_amount_paise / 100) : ""
  );
  const pending = row.txn.status === "pending";

  return (
    <tr className={pending ? "bg-pending-soft/40" : ""}>
      <td>
        <input type="date" value={row.txn.date}
          onChange={(e) => onSave(row, { date: e.target.value })} />
      </td>
      <td>
        <input value={desc} onChange={(e) => setDesc(e.target.value)}
          onBlur={() => desc.trim() && desc !== row.txn.description && onSave(row, { description: desc.trim() })} />
      </td>
      <td>
        <AccountSelect value={row.fromId} choices={fromChoices}
          onChange={(v) => v && onSave(row, { fromAccountId: v })} />
      </td>
      <td>
        <AccountSelect value={row.toId} choices={toChoices}
          onChange={(v) => v && onSave(row, { toAccountId: v })} />
      </td>
      <td>
        <input value={amount} inputMode="decimal" className="text-right amount"
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => {
            const p = parseRupees(amount);
            if (p && p > 0 && p !== row.amountPaise) onSave(row, { amountPaise: p });
          }} />
      </td>
      <td className="whitespace-nowrap">
        <div className="flex">
          <AccountSelect value={row.txn.reimburse_account_id ?? ""} choices={people}
            onChange={(v) => onSave(row, { reimburseAccountId: v || null, reimbursePaise: v ? row.txn.reimburse_amount_paise : null })} />
          {row.txn.reimburse_account_id && (
            <input value={splitAmt} inputMode="decimal" placeholder="their ₹"
              className="text-right amount w-20"
              onChange={(e) => setSplitAmt(e.target.value)}
              onBlur={() => {
                const p = parseRupees(splitAmt);
                if (p !== null && p !== row.txn.reimburse_amount_paise) onSave(row, { reimbursePaise: p });
              }} />
          )}
        </div>
      </td>
      <td>
        <button onClick={onToggle}
          className={`text-xs px-2 py-1 border ${pending
            ? "border-pending text-pending bg-pending-soft"
            : "border-ledger text-ledger"}`}>
          {pending ? "pending" : "done"}
        </button>
      </td>
      <td>
        <button onClick={onDelete} className="text-ink-faint hover:text-debit px-2" title="Delete entry">×</button>
      </td>
    </tr>
  );
}

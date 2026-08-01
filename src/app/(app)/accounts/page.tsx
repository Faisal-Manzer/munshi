"use client";

import { useState } from "react";
import { useLedger } from "@/lib/use-ledger";
import { Amount } from "@/components/amount";
import { InputModal } from "@/components/modal";
import { formatPaise, parseRupees } from "@/lib/money";
import { displayBalance, subtreeBalance } from "@/lib/ledger";
import type { Account, AccountKind, AccountSubtype } from "@/lib/types";

const NEW_OPTIONS: {
  label: string;
  kind: AccountKind;
  subtype: AccountSubtype;
  needsParent?: "bank" | "credit_card";
}[] = [
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

export default function AccountsPage() {
  const { supabase, accounts, balances, loading, error, reload } = useLedger();
  const [showForm, setShowForm] = useState(false);
  const [optIdx, setOptIdx] = useState(0);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [stmtDay, setStmtDay] = useState("");
  const [limit, setLimit] = useState("");
  const [opening, setOpening] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [reconFor, setReconFor] = useState<Account | null>(null);

  const opt = NEW_OPTIONS[optIdx];
  const active = accounts.filter((a) => !a.archived);
  const parentChoices = opt.needsParent
    ? active.filter((a) =>
        opt.needsParent === "bank"
          ? a.subtype === "bank"
          : a.subtype === "credit_card" && a.parent_id === null
      )
    : [];

  async function addAccount() {
    if (!name.trim()) return;
    if (opt.needsParent && !parentId) {
      setFormError("Pick a parent account.");
      return;
    }
    setSaving(true);
    setFormError(null);
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
      setFormError(e1.message);
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
      // asset opening: debit account; liability opening (owed): credit account
      const sign = opt.kind === "liability" ? -1 : 1;
      const { data: txn } = await supabase
        .from("transactions")
        .insert({
          date: new Date().toISOString().slice(0, 10),
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

    setName("");
    setOpening("");
    setDueDay("");
    setStmtDay("");
    setLimit("");
    setShowForm(false);
    setSaving(false);
    reload();
  }

  async function reportBalance(a: Account, input: string) {
    const paise = parseRupees(input);
    if (paise === null) return;
    const signed = a.kind === "liability" ? -paise : paise;
    await supabase
      .from("accounts")
      .update({ reported_balance_paise: signed, reported_at: new Date().toISOString() })
      .eq("id", a.id);
    reload();
  }

  async function archive(a: Account) {
    if (!confirm(`Archive ${a.name}? It stays in history but hides from lists.`)) return;
    await supabase.from("accounts").update({ archived: true }).eq("id", a.id);
    reload();
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading accounts…</p>;
  if (error) return <p className="text-sm text-debit">{error}</p>;

  const banks = active.filter((a) => a.subtype === "bank");
  const cash = active.filter((a) => ["cash", "investment"].includes(a.subtype));
  const cards = active.filter((a) => a.subtype === "credit_card" && a.parent_id === null);
  const loans = active.filter((a) => a.subtype === "loan");
  const people = active.filter((a) => a.subtype === "receivable");
  const income = active.filter((a) => a.kind === "income");
  const expenses = active.filter((a) => a.kind === "expense");

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Accounts</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="border border-ledger text-ledger px-3 py-1.5 text-sm hover:bg-ledger-soft"
        >
          {showForm ? "Close" : "+ New account"}
        </button>
      </div>

      {showForm && (
        <div className="border border-rule bg-paper-raised p-4 grid gap-3 sm:grid-cols-2">
          <select
            value={optIdx}
            onChange={(e) => setOptIdx(Number(e.target.value))}
            className="border border-rule px-2 py-1.5 text-sm bg-paper-raised"
          >
            {NEW_OPTIONS.map((o, i) => (
              <option key={o.label} value={i}>{o.label}</option>
            ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. HDFC Savings, Amazon ICICI)"
            className="border border-rule px-2 py-1.5 text-sm bg-paper-raised"
          />
          {opt.needsParent && (
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="border border-rule px-2 py-1.5 text-sm bg-paper-raised"
            >
              <option value="">Parent {opt.needsParent === "bank" ? "bank" : "card"}…</option>
              {parentChoices.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          {opt.subtype === "credit_card" && !opt.needsParent && (
            <>
              <input value={stmtDay} onChange={(e) => setStmtDay(e.target.value)}
                placeholder="Statement day (1–31)" className="border border-rule px-2 py-1.5 text-sm bg-paper-raised" />
              <input value={dueDay} onChange={(e) => setDueDay(e.target.value)}
                placeholder="Due day (1–31)" className="border border-rule px-2 py-1.5 text-sm bg-paper-raised" />
              <input value={limit} onChange={(e) => setLimit(e.target.value)}
                placeholder="Credit limit ₹ (optional)" className="border border-rule px-2 py-1.5 text-sm bg-paper-raised" />
            </>
          )}
          {(opt.subtype === "bank" || opt.subtype === "cash" || opt.subtype === "loan" ||
            opt.subtype === "credit_card" || opt.subtype === "receivable") && (
            <input value={opening} onChange={(e) => setOpening(e.target.value)}
              placeholder={opt.kind === "liability" ? "Current outstanding ₹ (optional)" : "Current balance ₹ (optional)"}
              className="border border-rule px-2 py-1.5 text-sm bg-paper-raised" />
          )}
          {formError && <p className="text-sm text-debit sm:col-span-2">{formError}</p>}
          <button onClick={addAccount} disabled={saving}
            className="bg-ledger text-paper-raised px-3 py-1.5 text-sm sm:col-span-2 disabled:opacity-60">
            {saving ? "Saving…" : "Add account"}
          </button>
        </div>
      )}

      <Section title="Bank accounts">
        {banks.map((b) => {
          const envelopes = active.filter((a) => a.parent_id === b.id);
          const total = subtreeBalance(accounts, balances, b.id);
          const own = balances.get(b.id)?.balance_paise ?? 0;
          const gap = b.reported_balance_paise !== null ? b.reported_balance_paise - total : null;
          return (
            <div key={b.id} className="border border-rule bg-paper-raised">
              <Row
                name={b.name}
                right={<Amount paise={total} />}
                sub={envelopes.length > 0 ? `Available ${formatPaise(own)} · set aside ${formatPaise(total - own)}` : undefined}
                gap={gap}
                onReport={() => setReconFor(b)}
                onArchive={() => archive(b)}
              />
              {envelopes.map((env) => (
                <Row key={env.id} indent name={env.name}
                  right={<Amount paise={balances.get(env.id)?.balance_paise ?? 0} />}
                  onArchive={() => archive(env)} />
              ))}
            </div>
          );
        })}
        {cash.map((c) => (
          <div key={c.id} className="border border-rule bg-paper-raised">
            <Row name={c.name} right={<Amount paise={balances.get(c.id)?.balance_paise ?? 0} />}
              onArchive={() => archive(c)} />
          </div>
        ))}
      </Section>

      <Section title="Credit cards">
        {cards.map((card) => {
          const subs = active.filter((a) => a.parent_id === card.id);
          const owed = -subtreeBalance(accounts, balances, card.id);
          const gap = card.reported_balance_paise !== null
            ? -card.reported_balance_paise - owed
            : null;
          return (
            <div key={card.id} className="border border-rule bg-paper-raised">
              <Row
                name={card.name}
                right={<Amount paise={owed} className={owed > 0 ? "text-debit" : ""} />}
                sub={[
                  card.due_day ? `due ${ordinal(card.due_day)}` : null,
                  card.statement_day ? `statement ${ordinal(card.statement_day)}` : null,
                  card.credit_limit_paise ? `limit ${formatPaise(card.credit_limit_paise)}` : null,
                  subs.length ? `${subs.length} sub-card${subs.length > 1 ? "s" : ""} billed here` : null,
                ].filter(Boolean).join(" · ")}
                gap={gap}
                gapLabel="vs card app"
                onReport={() => setReconFor(card)}
                onArchive={() => archive(card)}
              />
              {subs.map((s) => (
                <Row key={s.id} indent name={s.name}
                  right={<Amount paise={-(balances.get(s.id)?.balance_paise ?? 0)} />}
                  onArchive={() => archive(s)} />
              ))}
            </div>
          );
        })}
      </Section>

      <Section title="Loans you owe">
        {loans.map((l) => (
          <div key={l.id} className="border border-rule bg-paper-raised">
            <Row name={l.name}
              right={<Amount paise={displayBalance(l, balances.get(l.id)?.balance_paise ?? 0)} />}
              onReport={() => setReconFor(l)}
              gap={l.reported_balance_paise !== null
                ? l.reported_balance_paise - (balances.get(l.id)?.balance_paise ?? 0)
                : null}
              onArchive={() => archive(l)} />
          </div>
        ))}
      </Section>

      <Section title="People (owe you)">
        {people.map((p) => (
          <div key={p.id} className="border border-rule bg-paper-raised">
            <Row name={p.name}
              right={<Amount paise={balances.get(p.id)?.balance_paise ?? 0} className="text-ledger" />}
              onArchive={() => archive(p)} />
          </div>
        ))}
      </Section>

      <Section title="Income sources">
        {income.map((p) => (
          <div key={p.id} className="border border-rule bg-paper-raised">
            <Row name={p.name}
              right={<Amount paise={displayBalance(p, balances.get(p.id)?.balance_paise ?? 0)} />}
              onArchive={() => archive(p)} />
          </div>
        ))}
      </Section>

      <Section title="Expense categories">
        {expenses.map((p) => (
          <div key={p.id} className="border border-rule bg-paper-raised">
            <Row name={p.name}
              right={<Amount paise={balances.get(p.id)?.balance_paise ?? 0} />}
              onArchive={() => archive(p)} />
          </div>
        ))}
      </Section>

      <InputModal
        open={reconFor !== null}
        title={reconFor ? `Reconcile ${reconFor.name}` : ""}
        label={reconFor?.kind === "liability"
          ? "Actual outstanding from the card/bank app (₹)"
          : "Actual balance from the bank app (₹)"}
        placeholder="0"
        submitLabel="Save"
        onSubmit={async (v) => {
          if (reconFor) await reportBalance(reconFor, v);
        }}
        onClose={() => setReconFor(null)}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : [children];
  return (
    <section>
      <h2 className="text-xs uppercase tracking-[0.15em] text-ink-faint mb-2 font-sans font-medium">
        {title}
      </h2>
      <div className="space-y-2">
        {items.length === 0 || (Array.isArray(children) && children.every((c) => !c || (Array.isArray(c) && c.length === 0))) ? (
          <p className="text-sm text-ink-faint border border-dashed border-rule p-3">
            Nothing here yet — add one with “New account”.
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function Row({
  name, right, sub, gap, gapLabel = "vs bank", indent, onReport, onArchive,
}: {
  name: string;
  right: React.ReactNode;
  sub?: string;
  gap?: number | null;
  gapLabel?: string;
  indent?: boolean;
  onReport?: () => void;
  onArchive?: () => void;
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 border-b border-rule last:border-b-0 ${indent ? "pl-8 bg-paper" : ""}`}>
      <div className="min-w-0">
        <p className="text-sm truncate">{indent ? "↳ " : ""}{name}</p>
        {sub && <p className="text-xs text-ink-faint">{sub}</p>}
        {gap !== null && gap !== undefined && gap !== 0 && (
          <p className="text-xs text-debit">
            {gapLabel}: {gap > 0 ? "+" : ""}{formatPaise(gap)} unlogged
          </p>
        )}
      </div>
      <div className="ml-auto text-right">{right}</div>
      <div className="flex gap-2 text-xs">
        {onReport && (
          <button onClick={onReport} className="text-ink-faint hover:text-ledger" title="Enter actual balance from bank/card app">
            reconcile
          </button>
        )}
        {onArchive && (
          <button onClick={onArchive} className="text-ink-faint hover:text-debit">
            archive
          </button>
        )}
      </div>
    </div>
  );
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

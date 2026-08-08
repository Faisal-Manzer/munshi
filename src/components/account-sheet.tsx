"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useLedger } from "@/lib/use-ledger";
import { Amount } from "@/components/amount";
import { Field } from "@/components/field";
import { Select } from "@/components/select";
import { createEntry, postEquityAdjustment } from "@/lib/postings";
import { emiInfo, fmtMonth } from "@/lib/emi";
import { formatPaise, parseRupees } from "@/lib/money";
import { displayBalance, subtreeBalance, toISODate } from "@/lib/ledger";
import { cardDueNow, cardUnbilled } from "@/lib/calc";
import { ArrowDownLeft, Scale, X } from "lucide-react";
import type { Account, AccountSubtype, Posting, RecurringTemplate, Transaction } from "@/lib/types";

const SUBTYPE_LABEL: Record<AccountSubtype, string> = {
  bank: "Bank account",
  envelope: "Envelope",
  cash: "Cash",
  investment: "Investment",
  receivable: "Person",
  credit_card: "Credit card",
  loan: "Loan",
  salary: "Income source",
  other_income: "Income source",
  general_expense: "Expense category",
  opening_balance: "Opening balances",
};

type HistoryRow = Posting & { transactions: Transaction; running: number };

/**
 * One detail surface for every sidebar entity — banks, cards, people,
 * loans, investments, categories. Header (rename + balance), contextual
 * actions, History with running balance, Settings.
 */
export function AccountSheet({
  accountId, onDone, onReconcile, onOpenAccount, onAddChild, onClose,
}: {
  accountId: string | null;
  onDone: () => Promise<unknown>;
  onReconcile: (a: Account) => void;
  /** Navigate this sheet to another account (envelope, sub-card). */
  onOpenAccount: (id: string) => void;
  /** Open the create-account modal scoped to the given NEW_OPTIONS indexes. */
  onAddChild: (optionIdxs: number[]) => void;
  onClose: () => void;
}) {
  const { supabase, accounts, balances, cycles, reload } = useLedger();
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  const [tab, setTab] = useState<"history" | "settings">("history");
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [outstandingOpen, setOutstandingOpen] = useState(false);
  const [loanTemplate, setLoanTemplate] = useState<RecurringTemplate | null>(null);

  useEffect(() => {
    setTab("history");
    setSettleOpen(false);
    setOutstandingOpen(false);
    setRows(null);
  }, [accountId]);

  // the EMI template that pays this loan, if any — shows progress + remaining
  useEffect(() => {
    setLoanTemplate(null);
    if (!accountId) return;
    supabase
      .from("recurring_templates")
      .select("*")
      .eq("to_account_id", accountId)
      .eq("active", true)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setLoanTemplate((data as RecurringTemplate) ?? null));
  }, [supabase, accountId]);

  const loadHistory = useCallback(async () => {
    if (!accountId) return;
    const { data, error: e } = await supabase
      .from("postings")
      .select("*, transactions(*)")
      .eq("account_id", accountId);
    if (e) {
      setError(e.message);
      return;
    }
    const list = (data ?? []) as (Posting & { transactions: Transaction })[];
    list.sort((a, b) => {
      if (a.transactions.date !== b.transactions.date)
        return a.transactions.date < b.transactions.date ? -1 : 1;
      return (a.transactions.created_at ?? "") < (b.transactions.created_at ?? "") ? -1 : 1;
    });
    let run = 0;
    const withRun = list.map((r) => ({ ...r, running: (run += r.amount_paise) }));
    withRun.reverse(); // newest first
    setRows(withRun);
    setError(null);
  }, [supabase, accountId]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const refreshAll = useCallback(
    () => Promise.all([reload(), loadHistory(), onDone()]),
    [reload, loadHistory, onDone]
  );

  // escape closes
  useEffect(() => {
    if (!accountId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accountId, onClose]);

  if (!accountId) return null;

  const bal = account ? balances.get(account.id)?.balance_paise ?? 0 : 0;
  const isPerson = account?.subtype === "receivable";
  const isLoan = account?.subtype === "loan";
  const isParentCard = account?.subtype === "credit_card" && account.parent_id === null;
  const isReconcilable = account
    ? ["bank", "cash", "envelope", "investment", "credit_card", "loan", "receivable"].includes(account.subtype)
    : false;
  const children = account ? active.filter((a) => a.parent_id === account.id) : [];

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-backdrop absolute inset-0 -z-10 pointer-events-none"
        style={{ background: "rgba(28,36,32,0.35)" }} aria-hidden />
      <div
        className="sheet-panel no-scrollbar w-full max-w-[540px] h-full overflow-y-auto border-l border-rule-strong bg-paper-raised shadow-xl"
      >
        {!account ? (
          <p className="p-6 text-sm text-ink-faint">Loading…</p>
        ) : (
          <>
            <SheetHeader account={account}
              parent={account.parent_id ? accounts.find((a) => a.id === account.parent_id) ?? null : null}
              supabase={supabase} onSaved={refreshAll} onOpenParent={onOpenAccount} onClose={onClose} />
            <BalanceSummary account={account} accounts={accounts} active={active}
              balances={balances} cycles={cycles} loanTemplate={loanTemplate} />

            {/* actions */}
            <div className="px-5 py-3 flex flex-wrap gap-2 border-b border-rule">
              {isReconcilable && (
                <ActionBtn onClick={() => onReconcile(account)}>
                  <Scale size={12} /> Reconcile
                </ActionBtn>
              )}
              {isPerson && bal !== 0 && (
                <ActionBtn onClick={() => setSettleOpen((v) => !v)} primary>
                  {bal > 0 ? "Settle up — they paid you" : "Settle up — you paid them"}
                </ActionBtn>
              )}
              {isLoan && (
                <ActionBtn onClick={() => setOutstandingOpen((v) => !v)} primary={bal >= 0}>
                  Set outstanding
                </ActionBtn>
              )}
              {account?.subtype === "bank" && account.parent_id === null && (
                <ActionBtn onClick={() => onAddChild([1])}>+ Envelope</ActionBtn>
              )}
              {isParentCard && (
                <ActionBtn onClick={() => onAddChild([5])}>+ Sub-card</ActionBtn>
              )}
            </div>

            {outstandingOpen && isLoan && account && (
              <OutstandingForm account={account} balance={bal} template={loanTemplate} supabase={supabase}
                onDone={async () => {
                  setOutstandingOpen(false);
                  await refreshAll();
                }}
                onError={setError} />
            )}

            {settleOpen && isPerson && (
              <SettleForm account={account} balance={bal} banks={active.filter((a) => a.is_liquid)}
                supabase={supabase}
                onDone={async () => {
                  setSettleOpen(false);
                  await refreshAll();
                }}
                onError={setError} />
            )}

            {/* tabs */}
            <div className="px-5 pt-3 flex gap-1 border-b border-rule">
              {(["history", "settings"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 text-sm border-b-2 -mb-px capitalize ${
                    tab === t
                      ? "border-ledger text-ledger font-medium"
                      : "border-transparent text-ink-soft hover:text-ink"
                  }`}>
                  {t}
                </button>
              ))}
            </div>

            {error && (
              <p className="mx-5 mt-3 text-sm text-debit border border-debit-soft bg-debit-soft px-3 py-2">
                {error}
              </p>
            )}

            {tab === "history" && (
              <History account={account} rows={rows} childrenAccounts={children}
                balances={balances} onOpenAccount={onOpenAccount} />
            )}
            {tab === "settings" && (
              <Settings account={account} supabase={supabase} onSaved={refreshAll} onClose={onClose} />
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

function SheetHeader({
  account, parent, supabase, onSaved, onOpenParent, onClose,
}: {
  account: Account;
  parent: Account | null;
  supabase: ReturnType<typeof useLedger>["supabase"];
  onSaved: () => Promise<unknown>;
  onOpenParent: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(account.name);
  useEffect(() => setName(account.name), [account.id, account.name]);

  async function saveName() {
    const v = name.trim();
    if (!v || v === account.name) return;
    const patch: Record<string, string> = { name: v };
    if (account.subtype === "receivable") patch.person_name = v;
    await supabase.from("accounts").update(patch).eq("id", account.id);
    await onSaved();
  }

  return (
    <div className="px-5 pt-4 pb-2 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="Account name — click to rename"
          title="Click to rename"
          className="w-full text-2xl bg-transparent hover:bg-ledger-soft/40 focus:bg-paper -mx-1 px-1"
          style={{ fontFamily: "var(--font-instrument-serif)" }}
        />
        <p className="text-[10px] uppercase tracking-[0.15em] text-ink-faint mt-0.5">
          {SUBTYPE_LABEL[account.subtype]}
          {account.is_liquid && " · liquid"}
          {account.archived && " · archived"}
          {parent && (
            <>
              {" · under "}
              <button onClick={() => onOpenParent(parent.id)}
                className="normal-case tracking-normal text-ledger hover:underline">
                {parent.name}
              </button>
            </>
          )}
        </p>
      </div>
      <button onClick={onClose} aria-label="Close" title="Close" className="text-ink-faint hover:text-ink p-1">
        <X size={16} />
      </button>
    </div>
  );
}

function BalanceSummary({
  account, accounts, active, balances, cycles, loanTemplate,
}: {
  account: Account;
  accounts: Account[];
  active: Account[];
  balances: ReturnType<typeof useLedger>["balances"];
  cycles: ReturnType<typeof useLedger>["cycles"];
  loanTemplate: RecurringTemplate | null;
}) {
  const bal = balances.get(account.id)?.balance_paise ?? 0;

  let main: number;
  let label: string;
  let detail: string | null = null;
  let cls = "";
  let incoming = false;

  if (account.subtype === "receivable") {
    main = bal; // signed: what they owe you is +, what you owe is −
    label = bal === 0 ? "all settled" : "";
    cls = bal > 0 ? "text-ledger" : bal < 0 ? "text-debit" : "";
    incoming = bal > 0;
  } else if (account.subtype === "credit_card" && account.parent_id === null) {
    const due = cardDueNow(active, cycles, account);
    const unbilled = cardUnbilled(active, cycles, account);
    main = -(due + unbilled);
    label = "";
    cls = due + unbilled > 0 ? "text-debit" : "";
    detail = [
      due > 0 ? `due ${formatPaise(due)}` : null,
      unbilled > 0 ? `unbilled ${formatPaise(unbilled)}` : null,
    ].filter(Boolean).join(" · ") || "nothing owed";
  } else if (account.subtype === "loan") {
    main = displayBalance(account, bal);
    const parts: string[] = [];
    if (loanTemplate) {
      const e = emiInfo(loanTemplate, toISODate(new Date()).slice(0, 7));
      if (e) {
        const done = Math.min(Math.max(e.idx, 0), e.total);
        parts.push(`EMI ${done}/${e.total} · ${formatPaise(loanTemplate.amount_paise)}/mo · ends ${fmtMonth(e.endISO)}`);
      } else {
        parts.push(`${formatPaise(loanTemplate.amount_paise)}/mo`);
      }
    }
    if (main >= 0) {
      label = "";
      cls = main > 0 ? "text-debit" : "";
      main = -main;
    } else {
      label = "paid so far";
      main = -main;
      parts.push("outstanding not set — use “Set outstanding” to track what's left");
    }
    detail = parts.join(" · ") || null;
  } else if (account.kind === "income") {
    main = -bal;
    label = "earned all time";
  } else if (account.kind === "expense") {
    main = bal;
    label = "spent all time";
  } else {
    main = subtreeBalance(accounts, balances, account.id);
    label = "";
    const own = bal;
    if (main !== own) detail = `free ${formatPaise(own)} — rest set aside in envelopes`;
  }

  return (
    <div className="px-5 pb-3">
      <p className={`amount text-2xl inline-flex items-center gap-1 ${cls}`}>
        {incoming && <ArrowDownLeft size={18} className="text-ledger" />}
        {formatPaise(main)}
      </p>
      {(label || detail) && (
        <p className="text-xs text-ink-faint">
          {[label, detail].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}

function ActionBtn({
  onClick, primary, children,
}: {
  onClick: () => void;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 border ${
        primary
          ? "border-ledger text-ledger hover:bg-ledger-soft"
          : "border-rule text-ink-soft hover:text-ledger hover:border-ledger"
      }`}>
      {children}
    </button>
  );
}

function OutstandingForm({
  account, balance, template, supabase, onDone, onError,
}: {
  account: Account;
  balance: number;
  template: RecurringTemplate | null;
  supabase: ReturnType<typeof useLedger>["supabase"];
  onDone: () => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const current = displayBalance(account, balance); // positive = remaining owed
  // schedule-based estimate: installments left × EMI amount
  let suggested: number | null = null;
  let suggestedWhy = "";
  const e = template ? emiInfo(template, toISODate(new Date()).slice(0, 7)) : null;
  if (template && e) {
    const done = Math.min(Math.max(e.idx, 0), e.total);
    const left = e.total - done;
    // a split EMI books only your share into the loan — suggest that share,
    // or the payments themselves will never bring the outstanding to zero
    const share = template.amount_paise - (template.reimburse_amount_paise ?? 0);
    if (left > 0 && share > 0) {
      suggested = left * share;
      suggestedWhy = template.reimburse_amount_paise
        ? `your share: ${left} × ${formatPaise(share)} left by schedule (EMI ${done}/${e.total}; ` +
          `the other ${formatPaise(template.reimburse_amount_paise)}/mo is owed back to you and never touches this loan)`
        : `${left} × ${formatPaise(share)} left by schedule (EMI ${done}/${e.total})`;
    }
  }
  const [amt, setAmt] = useState(
    current > 0 ? String(current / 100) : suggested ? String(suggested / 100) : ""
  );

  async function submit() {
    const paise = parseRupees(amt);
    if (paise === null || paise < 0) return;
    // target ledger balance for a liability is -outstanding
    const delta = -paise - balance;
    try {
      await postEquityAdjustment(
        supabase, account.ledger_id, account.id, delta,
        `Outstanding set — ${account.name}`, toISODate(new Date())
      );
      onError(null);
      await onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <div className="px-5 py-3 border-b border-rule bg-ledger-soft/30 space-y-2">
      <Field label="Remaining outstanding today (₹)"
        hint="From your loan app/statement — posts a balanced opening adjustment; payments you log keep reducing it">
        <input value={amt} onChange={(e) => setAmt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          inputMode="decimal" autoFocus placeholder="e.g. 1,40,436"
          className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount" />
      </Field>
      {suggested !== null && (
        <button type="button" onClick={() => setAmt(String(suggested / 100))}
          className="text-xs text-ledger hover:underline text-left">
          Suggested: {formatPaise(suggested)} — {suggestedWhy}. Adjust if your
          loan app shows a different figure (interest makes them differ).
        </button>
      )}
      <button onClick={submit}
        className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90">
        Save outstanding
      </button>
    </div>
  );
}

function SettleForm({
  account, balance, banks, supabase, onDone, onError,
}: {
  account: Account;
  balance: number;
  banks: Account[];
  supabase: ReturnType<typeof useLedger>["supabase"];
  onDone: () => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const theyPay = balance > 0;
  const [amt, setAmt] = useState(String(Math.abs(balance) / 100));
  const [bankId, setBankId] = useState(banks[0]?.id ?? "");

  async function submit() {
    const paise = parseRupees(amt);
    if (!paise || paise <= 0 || !bankId) return;
    try {
      await createEntry(supabase, {
        ledgerId: account.ledger_id,
        date: toISODate(new Date()),
        description: theyPay
          ? `Received from ${account.name}`
          : `Paid back ${account.name}`,
        status: "done",
        fromAccountId: theyPay ? account.id : bankId,
        toAccountId: theyPay ? bankId : account.id,
        amountPaise: paise,
      });
      onError(null);
      await onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <div className="px-5 py-3 border-b border-rule bg-ledger-soft/30 space-y-2">
      <Field label={theyPay ? "Amount received (₹)" : "Amount you paid (₹)"}
        hint={`Full settlement is ${formatPaise(Math.abs(balance))} — edit for a partial one`}>
        <input value={amt} onChange={(e) => setAmt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          inputMode="decimal" autoFocus
          className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount" />
      </Field>
      <Field label={theyPay ? "Into account" : "Paid from account"}>
        <Select chrome value={bankId} onChange={setBankId} placeholder="Choose…"
          groups={[{ options: banks.map((b) => ({ value: b.id, label: b.name })) }]} />
      </Field>
      <button onClick={submit}
        className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90">
        Record
      </button>
    </div>
  );
}

function History({
  account, rows, childrenAccounts, balances, onOpenAccount,
}: {
  account: Account;
  rows: HistoryRow[] | null;
  childrenAccounts: Account[];
  balances: ReturnType<typeof useLedger>["balances"];
  onOpenAccount: (id: string) => void;
}) {
  return (
    <div className="px-5 py-3">
      {childrenAccounts.length > 0 && (
        <div className="mb-3 border border-rule divide-y divide-rule/60">
          {childrenAccounts.map((c) => (
            <div key={c.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
              <button onClick={() => onOpenAccount(c.id)}
                className="text-xs text-ink-soft text-left hover:text-ledger"
                title={`${c.name} — details`}>
                ↳ {c.name}
              </button>
              <Amount paise={displayBalance(c, balances.get(c.id)?.balance_paise ?? 0)}
                className="text-xs" />
            </div>
          ))}
        </div>
      )}
      {rows === null && <p className="text-sm text-ink-faint">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="text-sm text-ink-faint">No entries touch this account yet.</p>
      )}
      {rows !== null && rows.length > 0 && (
        <table className="w-full text-sm ledger-grid">
          <thead>
            <tr className="text-left text-xs text-ink-faint">
              <th className="py-1.5 pr-3 font-medium w-20">Date</th>
              <th className="py-1.5 pr-3 font-medium">Entry</th>
              <th className="py-1.5 pr-2 font-medium text-right">Amount</th>
              <th className="py-1.5 font-medium text-right w-28">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}
                className={r.transactions.status === "pending" ? "bg-pending-soft/40" : ""}>
                <td className="py-1.5 pr-3 amount text-ink-faint whitespace-nowrap">
                  {new Date(r.transactions.date + "T00:00:00").toLocaleDateString("en-IN", {
                    day: "2-digit", month: "short", year: "2-digit",
                  })}
                </td>
                <td className="py-1.5 pr-3">
                  {r.transactions.description}
                  {r.transactions.status === "pending" && (
                    <span className="text-pending text-xs"> · pending</span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-right">
                  <Amount paise={r.amount_paise} signed />
                </td>
                <td className="py-1.5 text-right">
                  <Amount paise={displayBalance(account, r.running)} className="text-ink-faint" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Settings({
  account, supabase, onSaved, onClose,
}: {
  account: Account;
  supabase: ReturnType<typeof useLedger>["supabase"];
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const isParentCard = account.subtype === "credit_card" && account.parent_id === null;
  const [stmtDay, setStmtDay] = useState(account.statement_day ? String(account.statement_day) : "");
  const [dueDay, setDueDay] = useState(account.due_day ? String(account.due_day) : "");
  const [limit, setLimit] = useState(
    account.credit_limit_paise ? String(account.credit_limit_paise / 100) : ""
  );
  const [liquid, setLiquid] = useState(account.is_liquid);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const input = "border border-rule px-2 py-1.5 text-sm bg-paper-raised w-full";

  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({
        statement_day: stmtDay ? Number(stmtDay) : null,
        due_day: dueDay ? Number(dueDay) : null,
        credit_limit_paise: parseRupees(limit),
        is_liquid: liquid,
      })
      .eq("id", account.id);
    setSaving(false);
    if (error) {
      setErr(error.message);
      return;
    }
    setErr(null);
    await onSaved();
  }

  async function archive() {
    if (!confirm(`Archive ${account.name}? It stays in history but hides from lists.`)) return;
    const { error } = await supabase
      .from("accounts")
      .update({ archived: true })
      .eq("id", account.id);
    if (error) {
      setErr(error.message);
      return;
    }
    await onSaved();
    onClose();
  }

  return (
    <div className="px-5 py-4 space-y-3">
      {isParentCard && (
        <>
          <Field label="Statement day" hint="Day of the month the bill is generated (1–31)">
            <input className={input} value={stmtDay} onChange={(e) => setStmtDay(e.target.value)}
              placeholder="e.g. 3" inputMode="numeric" />
          </Field>
          <Field label="Due day" hint="Day of the month payment is due (1–31)">
            <input className={input} value={dueDay} onChange={(e) => setDueDay(e.target.value)}
              placeholder="e.g. 19" inputMode="numeric" />
          </Field>
          <Field label="Credit limit (₹)" hint="Optional">
            <input className={input} value={limit} onChange={(e) => setLimit(e.target.value)}
              placeholder="e.g. 1,00,000" inputMode="decimal" />
          </Field>
        </>
      )}
      {account.kind === "asset" && (
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={liquid} onChange={(e) => setLiquid(e.target.checked)} />
          Liquid — spendable cash, counted in liquid totals and offered for
          transfers/receives
        </label>
      )}
      {err && <p className="text-sm text-debit">{err}</p>}
      <div className="flex gap-2 pt-1">
        <button onClick={save} disabled={saving}
          className="flex-1 bg-ledger text-paper-raised px-3 py-1.5 text-sm disabled:opacity-60">
          {saving ? "Saving…" : "Save settings"}
        </button>
        {!account.archived && (
          <button onClick={archive} disabled={saving}
            className="border border-debit text-debit px-3 py-1.5 text-sm hover:bg-debit-soft disabled:opacity-60">
            Archive
          </button>
        )}
      </div>
      <p className="text-[11px] text-ink-faint">
        To rename, click the name at the top of this panel.
      </p>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { createEntry, rewriteEntry, type EntryInput } from "@/lib/postings";
import { Amount } from "@/components/amount";
import { AccountSelect, NEW_CATEGORY } from "@/components/account-select";
import { InputModal, Modal } from "@/components/modal";
import { formatPaise, parseRupees } from "@/lib/money";
import { subtreeBalance, toISODate } from "@/lib/ledger";
import {
  DEFAULT_TAGS,
  type Account,
  type Posting,
  type RecurringTemplate,
  type Transaction,
} from "@/lib/types";

interface TxnRow {
  kind: "txn";
  date: string;
  txn: Transaction & { postings: Posting[] };
  fromId: string | null;
  toId: string | null;
  amountPaise: number;
  complex: boolean; // more than one credited account — render read-only
}
interface VirtualRow {
  kind: "virtual";
  date: string;
  template: RecurringTemplate;
}
interface ReceiveRow {
  kind: "receive";
  date: string;
  template: RecurringTemplate;
  personId: string;
  amountPaise: number;
  received: boolean;
}
type Row = TxnRow | VirtualRow | ReceiveRow;

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

export default function BookPage() {
  const { supabase, accounts, balances, cycles, loading, reload } = useLedger();
  const [txns, setTxns] = useState<(Transaction & { postings: Posting[] })[]>([]);
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [month, setMonth] = useState(() => toISODate(new Date()).slice(0, 7));
  const [error, setError] = useState<string | null>(null);
  const [postModal, setPostModal] = useState<RecurringTemplate | null>(null);
  const [receiveModal, setReceiveModal] = useState<ReceiveRow | null>(null);
  const [receiveAmt, setReceiveAmt] = useState("");
  const [receiveBank, setReceiveBank] = useState("");

  const today = toISODate(new Date());
  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const banks = useMemo(
    () => active.filter((a) => ["bank", "cash"].includes(a.subtype)),
    [active]
  );

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

  const knownTags = useMemo(() => {
    const s = new Set(DEFAULT_TAGS);
    for (const t of txns) if (t.tag) s.add(t.tag);
    return [...s];
  }, [txns]);

  // ---- build unified rows
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const rows: Row[] = [];
  for (const t of txns) {
    const negs = t.postings.filter((p) => p.amount_paise < 0);
    const pos = t.postings.filter((p) => p.amount_paise > 0);
    const to = pos.find((p) => p.account_id !== t.reimburse_account_id) ?? pos[0];
    rows.push({
      kind: "txn",
      date: t.date,
      txn: t,
      fromId: negs[0]?.account_id ?? null,
      toId: to?.account_id ?? null,
      amountPaise: negs.length === 1
        ? -negs[0].amount_paise
        : pos.reduce((s, p) => s + p.amount_paise, 0),
      complex: negs.length !== 1,
    });
  }
  // credits made to each person this month (they paid you back)
  const personCredits = new Map<string, number>();
  for (const t of txns) {
    for (const p of t.postings) {
      if (p.amount_paise < 0) {
        const acc = accountById(accounts, p.account_id);
        if (acc?.subtype === "receivable") {
          personCredits.set(acc.id, (personCredits.get(acc.id) ?? 0) + -p.amount_paise);
        }
      }
    }
  }
  for (const t of templates) {
    if (!txns.some((x) => x.recurring_template_id === t.id)) {
      const day = Math.min(t.day_of_month, daysInMonth);
      rows.push({
        kind: "virtual",
        date: `${month}-${String(day).padStart(2, "0")}`,
        template: t,
      });
    }
    if (t.reimburse_account_id && t.reimburse_amount_paise) {
      const day = Math.min(t.reimburse_expected_day ?? t.day_of_month, daysInMonth);
      rows.push({
        kind: "receive",
        date: `${month}-${String(day).padStart(2, "0")}`,
        template: t,
        personId: t.reimburse_account_id,
        amountPaise: t.reimburse_amount_paise,
        received:
          (personCredits.get(t.reimburse_account_id) ?? 0) >= t.reimburse_amount_paise,
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // ---- summary
  const isIncomeT = (t: RecurringTemplate) =>
    accountById(accounts, t.from_account_id)?.kind === "income";
  const isInternalT = (t: RecurringTemplate) => {
    if (t.is_budget) return false; // budget moves are committed spend
    const from = accountById(accounts, t.from_account_id);
    const to = accountById(accounts, t.to_account_id);
    return from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";
  };
  const plannedIn = templates.filter(isIncomeT).reduce((s, t) => s + t.amount_paise, 0);
  // cash committed: only templates that take money from bank/cash this month —
  // card-charged items cost cash later, via the card bill (counted in card owed)
  const committed = templates
    .filter((t) => {
      if (isIncomeT(t) || isInternalT(t)) return false;
      return accountById(accounts, t.from_account_id)?.subtype !== "credit_card";
    })
    .reduce((s, t) => s + t.amount_paise, 0);
  const expectedBack = templates.reduce((s, t) => s + (t.reimburse_amount_paise ?? 0), 0);
  const avoidable = txns
    .filter((t) => t.tag?.toLowerCase().includes("avoid"))
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
  const cardUnbilled = (card: Account) =>
    [card, ...active.filter((a) => a.parent_id === card.id)]
      .reduce((s, c) => s + -(cycles.get(c.id)?.spends_since_paise ?? 0), 0);
  const totalDue = parentCards.reduce((s, c) => s + cardDueNow(c), 0);
  const totalCardOwed = parentCards.reduce(
    (s, c) => s + cardDueNow(c) + cardUnbilled(c),
    0
  );

  // ---- actions
  async function postVirtual(t: RecurringTemplate, amountStr: string) {
    const paise = parseRupees(amountStr);
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

  function openReceive(r: ReceiveRow) {
    setReceiveAmt(String(r.amountPaise / 100));
    setReceiveBank(banks[0]?.id ?? "");
    setReceiveModal(r);
  }

  async function recordReceive() {
    if (!receiveModal) return;
    const paise = parseRupees(receiveAmt);
    if (!paise || paise <= 0 || !receiveBank) return;
    const person = accountById(accounts, receiveModal.personId);
    try {
      await createEntry(supabase, {
        date: today,
        description: `${person?.name} repays ${receiveModal.template.name}`,
        status: "done",
        fromAccountId: receiveModal.personId,
        toAccountId: receiveBank,
        amountPaise: paise,
      });
      setError(null);
      setReceiveModal(null);
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  }

  async function patchTxn(id: string, patch: Partial<Transaction>) {
    await supabase.from("transactions").update(patch).eq("id", id);
    await refreshAll();
  }

  async function saveEdit(row: TxnRow, patch: Partial<EntryInput>) {
    if (!row.fromId || !row.toId) return;
    try {
      await rewriteEntry(supabase, row.txn.id, {
        date: row.txn.date,
        description: row.txn.description,
        status: row.txn.status,
        fromAccountId: row.fromId,
        toAccountId: row.toId,
        amountPaise: row.amountPaise,
        reimburseAccountId: row.txn.reimburse_account_id,
        reimbursePaise: row.txn.reimburse_amount_paise,
        tag: row.txn.tag,
        notes: row.txn.notes,
        ...patch,
      });
      setError(null);
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    }
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

  const cellCls = "px-2 py-1.5";

  return (
    <div className="space-y-5">
      <datalist id="known-tags">
        {knownTags.map((t) => <option key={t} value={t} />)}
      </datalist>

      {/* header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => shiftMonth(-1)} className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft">←</button>
          <h1 className="text-3xl">{monthName}</h1>
          <button onClick={() => shiftMonth(1)} className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft">→</button>
        </div>
        <div className="flex gap-5 text-sm flex-wrap">
          <Headline label="in" paise={plannedIn} cls="text-ledger" />
          <Headline label="cash committed" paise={committed} />
          <Headline label="card due" paise={totalDue} cls={totalDue > 0 ? "text-debit" : ""} />
          <Headline label="card owed" paise={totalCardOwed} cls={totalCardOwed > 0 ? "text-debit" : ""} />
          <Headline label="coming back" paise={expectedBack} cls="text-ledger" />
          <Headline label="left" paise={plannedIn - committed - totalCardOwed + expectedBack} cls={plannedIn - committed - totalCardOwed + expectedBack >= 0 ? "text-ledger" : "text-debit"} />
          {avoidable > 0 && <Headline label="avoidable" paise={avoidable} cls="text-pending" />}
        </div>
      </div>

      {error && <p className="text-sm text-debit border border-debit-soft bg-debit-soft px-3 py-2">{error}</p>}

      <div className="grid xl:grid-cols-[1fr_310px] gap-5 items-start">
        {/* ledger */}
        <div className="border border-rule bg-paper-raised overflow-x-auto">
          <table className="ledger-grid w-full text-sm min-w-[860px]">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="px-2 py-2 font-medium w-32">Date</th>
                <th className="px-2 py-2 font-medium">Title</th>
                <th className="px-2 py-2 font-medium w-56">Account</th>
                <th className="px-2 py-2 font-medium w-28 text-right">Amount</th>
                <th className="px-2 py-2 font-medium w-28">Tag</th>
                <th className="px-2 py-2 font-medium w-40">Note</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              <QuickAddRow accounts={active} supabase={supabase} onDone={refreshAll} onError={setError} />
              {rows.map((row) => {
                if (row.kind === "virtual") {
                  const t = row.template;
                  const overdue = row.date < today;
                  const from = accountById(accounts, t.from_account_id);
                  const toAcc = accountById(accounts, t.to_account_id);
                  const isIn = from?.kind === "income";
                  const internal = !t.is_budget && from?.kind === "asset" &&
                    toAcc?.kind === "asset" && toAcc?.subtype !== "receivable";
                  return (
                    <tr key={"v" + t.id} className={overdue ? "bg-debit-soft/40" : "bg-paper"}>
                      <td className={`${cellCls} amount text-ink-faint whitespace-nowrap`}>{fmtDate(row.date)}</td>
                      <td className={cellCls}>
                        <span className={overdue ? "text-debit" : "text-ink-soft"}>{t.name}</span>
                        {overdue && <span className="text-xs text-debit font-medium"> · overdue</span>}
                      </td>
                      <td className={`${cellCls} text-xs text-ink-faint`}>
                        {from?.name}{internal ? " ⇄ " : " → "}{toAcc?.name}
                      </td>
                      <td className={`${cellCls} text-right`}>
                        <Amount paise={isIn ? t.amount_paise : internal ? t.amount_paise : -t.amount_paise}
                          signed={!internal} className={internal ? "text-ink-faint" : ""} />
                      </td>
                      <td className={cellCls}></td>
                      <td className={cellCls}></td>
                      <td className={`${cellCls} text-right`}>
                        <button onClick={() => setPostModal(t)}
                          className={`text-xs border px-2 py-1 whitespace-nowrap ${overdue ? "border-debit text-debit hover:bg-debit-soft" : "border-ledger text-ledger hover:bg-ledger-soft"}`}>
                          post
                        </button>
                      </td>
                    </tr>
                  );
                }
                if (row.kind === "receive") {
                  const person = accountById(accounts, row.personId);
                  const overdue = row.date < today && !row.received;
                  return (
                    <tr key={"r" + row.template.id}
                      className={row.received ? "" : overdue ? "bg-debit-soft/40" : "bg-paper"}>
                      <td className={`${cellCls} amount text-ink-faint whitespace-nowrap`}>{fmtDate(row.date)}</td>
                      <td className={cellCls}>
                        <span className={row.received ? "" : overdue ? "text-debit" : "text-ink-soft"}>
                          {person?.name} repays {row.template.name}
                        </span>
                        {row.received && <span className="text-xs text-ledger"> ✓ received</span>}
                        {overdue && <span className="text-xs text-debit font-medium"> · overdue</span>}
                      </td>
                      <td className={`${cellCls} text-xs text-ink-faint`}>
                        {person?.name} → you
                      </td>
                      <td className={`${cellCls} text-right`}>
                        <Amount paise={row.amountPaise} signed className="text-ledger" />
                      </td>
                      <td className={cellCls}></td>
                      <td className={cellCls}></td>
                      <td className={`${cellCls} text-right`}>
                        {!row.received && (
                          <button onClick={() => openReceive(row)}
                            className={`text-xs border px-2 py-1 whitespace-nowrap ${overdue ? "border-debit text-debit hover:bg-debit-soft" : "border-ledger text-ledger hover:bg-ledger-soft"}`}>
                            receive
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                }
                return (
                  <TxnEditRow
                    key={row.txn.id + row.txn.status + row.amountPaise + (row.fromId ?? "") + (row.toId ?? "")}
                    row={row}
                    accounts={accounts}
                    active={active}
                    today={today}
                    onSave={saveEdit}
                    onPatch={patchTxn}
                    onDelete={() => remove(row)}
                  />
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
              const owed = due + unbilled;
              return (
                <div key={c.id} className="px-3 py-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm">{c.name}</p>
                    <Amount paise={owed} className={owed > 0 ? "text-debit" : "text-ink-faint"} />
                  </div>
                  <p className="text-[11px] text-ink-faint">
                    {due > 0
                      ? `${formatPaise(due)} due by ${c.due_day} · ${formatPaise(unbilled)} unbilled (cuts ${c.statement_day})`
                      : `bill clear · ${formatPaise(unbilled)} unbilled, cuts ${c.statement_day} → due ${c.due_day}`}
                  </p>
                </div>
              );
            })}
          </SideBlock>

          <SideBlock title="People">
            {(() => {
              const owing = active
                .filter((a) => a.subtype === "receivable")
                .map((p) => ({ p, bal: balances.get(p.id)?.balance_paise ?? 0 }))
                .filter((x) => x.bal !== 0);
              if (owing.length === 0) {
                return <p className="px-3 py-1.5 text-xs text-ink-faint">All settled.</p>;
              }
              return owing.map(({ p, bal }) => (
                <div key={p.id} className="px-3 py-1.5 flex items-baseline justify-between gap-2">
                  <p className="text-sm">{p.name}
                    <span className="text-[11px] text-ink-faint"> {bal > 0 ? "owes you" : "you owe"}</span>
                  </p>
                  <Amount paise={Math.abs(bal)} className={bal > 0 ? "text-ledger" : "text-debit"} />
                </div>
              ));
            })()}
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

      <InputModal
        open={postModal !== null}
        title={postModal ? `Post "${postModal.name}"` : ""}
        label="Actual amount (₹) — planned amount prefilled"
        defaultValue={postModal ? String(postModal.amount_paise / 100) : ""}
        submitLabel="Post today"
        onSubmit={async (v) => {
          if (postModal) await postVirtual(postModal, v);
        }}
        onClose={() => setPostModal(null)}
      />

      <Modal
        open={receiveModal !== null}
        title={receiveModal
          ? `${accountById(accounts, receiveModal.personId)?.name} repays ${receiveModal.template.name}`
          : ""}
        onClose={() => setReceiveModal(null)}
      >
        <input
          value={receiveAmt}
          onChange={(e) => setReceiveAmt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && recordReceive()}
          inputMode="decimal"
          placeholder="Amount ₹"
          className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount"
          autoFocus
        />
        <select
          value={receiveBank}
          onChange={(e) => setReceiveBank(e.target.value)}
          className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised mt-2"
        >
          {banks.map((b) => (
            <option key={b.id} value={b.id}>into {b.name}</option>
          ))}
        </select>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => setReceiveModal(null)} className="text-sm text-ink-soft px-3 py-1.5 hover:text-ink">
            Cancel
          </button>
          <button onClick={recordReceive}
            className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90">
            Record
          </button>
        </div>
      </Modal>
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

function TxnEditRow({
  row, accounts, active, today, onSave, onPatch, onDelete,
}: {
  row: TxnRow;
  accounts: Account[];
  active: Account[];
  today: string;
  onSave: (row: TxnRow, patch: Partial<EntryInput>) => void;
  onPatch: (id: string, patch: Partial<Transaction>) => void;
  onDelete: () => void;
}) {
  const t = row.txn;
  const from = row.fromId ? accountById(accounts, row.fromId) : undefined;
  const to = row.toId ? accountById(accounts, row.toId) : undefined;
  const isIn = from?.kind === "income" || (from?.subtype === "receivable" && to?.kind === "asset");
  const isInternal = from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";
  const pending = t.status === "pending";

  const [desc, setDesc] = useState(t.description);
  const [amount, setAmount] = useState(String(row.amountPaise / 100));
  const [amountFocus, setAmountFocus] = useState(false);
  const [dateEdit, setDateEdit] = useState(false);

  if (row.complex) {
    // multi-leg entry (e.g. opening balances) — read-only so it can't be mangled
    return (
      <tr className="bg-paper">
        <td className="px-2 py-1.5 amount text-ink-faint whitespace-nowrap">{fmtDate(t.date)}</td>
        <td className="px-2 py-1.5 text-ink-soft">{t.description}</td>
        <td className="px-2 py-1.5 text-xs text-ink-faint">
          {t.postings?.length ?? "multiple"} accounts — see History
        </td>
        <td className="px-2 py-1.5 text-right amount text-ink-faint">—</td>
        <td className="px-2 py-1.5"></td>
        <td className="px-2 py-1.5 text-xs text-ink-faint">{t.notes ?? ""}</td>
        <td className="px-2 py-1.5 text-right">
          <button onClick={onDelete} className="text-ink-faint hover:text-debit">×</button>
        </td>
      </tr>
    );
  }

  const amountDisplay = amountFocus
    ? amount
    : `${isInternal ? "" : isIn ? "+" : "−"}${formatPaise(row.amountPaise)}`;

  const fromChoices = active.filter((a) =>
    ["bank", "envelope", "cash", "investment", "credit_card", "receivable", "salary", "other_income"].includes(a.subtype)
  );
  const toChoices = active.filter((a) =>
    !["salary", "other_income", "opening_balance"].includes(a.subtype)
  );

  return (
    <tr className={pending ? "bg-pending-soft/40" : ""}>
      <td>
        {dateEdit ? (
          <input type="date" value={t.date} autoFocus
            onChange={(e) => onSave(row, { date: e.target.value })}
            onBlur={() => setDateEdit(false)}
            className="amount" />
        ) : (
          <button onClick={() => setDateEdit(true)}
            className="amount text-ink-faint px-2 py-1.5 w-full text-left whitespace-nowrap hover:text-ink">
            {fmtDate(t.date)}
          </button>
        )}
      </td>
      <td>
        <input value={desc} onChange={(e) => setDesc(e.target.value)}
          onBlur={() => desc.trim() && desc !== t.description && onSave(row, { description: desc.trim() })} />
      </td>
      <td>
        <div className="flex items-center">
          <AccountSelect value={row.fromId ?? ""} choices={fromChoices} className="w-1/2 text-xs"
            onChange={(v) => v && onSave(row, { fromAccountId: v })} />
          <span className="text-ink-faint text-xs">{isInternal ? "⇄" : "→"}</span>
          <AccountSelect value={row.toId ?? ""} choices={toChoices} className="w-1/2 text-xs"
            onChange={(v) => v && onSave(row, { toAccountId: v })} />
        </div>
      </td>
      <td>
        <input value={amountDisplay} inputMode="decimal"
          onFocus={() => {
            setAmount(String(row.amountPaise / 100));
            setAmountFocus(true);
          }}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => {
            setAmountFocus(false);
            const p = parseRupees(amount);
            if (p && p > 0 && p !== row.amountPaise) onSave(row, { amountPaise: p });
          }}
          className={`text-right amount ${isIn ? "text-ledger" : isInternal ? "text-ink-faint" : "text-debit"}`} />
      </td>
      <td>
        <input list="known-tags" defaultValue={t.tag ?? ""} placeholder="—"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (t.tag ?? "")) onPatch(t.id, { tag: v || null });
          }}
          className={`text-xs ${t.tag ? "text-pending" : "text-ink-faint"}`} />
      </td>
      <td>
        <input defaultValue={t.notes ?? ""} placeholder="—"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (t.notes ?? "")) onPatch(t.id, { notes: v || null });
          }}
          className="text-xs text-ink-soft" />
      </td>
      <td className="px-2 py-1.5 text-right whitespace-nowrap">
        {t.recurring_template_id && <span className="text-xs text-ledger mr-1">✓</span>}
        {pending && (
          <button onClick={() => onPatch(t.id, { status: "done", date: today })}
            className="text-xs text-ledger hover:underline mr-1">paid</button>
        )}
        <button onClick={onDelete} className="text-ink-faint hover:text-debit">×</button>
      </td>
    </tr>
  );
}

function QuickAddRow({
  accounts, supabase, onDone, onError,
}: {
  accounts: Account[];
  supabase: ReturnType<typeof useLedger>["supabase"];
  onDone: () => Promise<unknown>;
  onError: (m: string | null) => void;
}) {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [tag, setTag] = useState("");
  const [note, setNote] = useState("");
  const [newCatOpen, setNewCatOpen] = useState(false);

  const fromChoices = accounts.filter((a) =>
    ["bank", "envelope", "cash", "investment", "credit_card", "receivable", "salary", "other_income"].includes(a.subtype)
  );
  const toChoices = accounts.filter((a) =>
    !["salary", "other_income", "opening_balance"].includes(a.subtype)
  );
  const spends = accounts.find((a) => a.name === "Spends" && a.kind === "expense");

  async function createCategory(name: string) {
    if (!name.trim()) return;
    const { data, error } = await supabase
      .from("accounts")
      .insert({ name: name.trim(), kind: "expense", subtype: "general_expense" })
      .select()
      .single();
    if (error) {
      onError(error.message);
      return;
    }
    await onDone();
    setToId(data.id);
  }

  async function submit() {
    const paise = parseRupees(amount);
    if (!desc.trim() || !fromId || !paise || paise <= 0) return;
    try {
      await createEntry(supabase, {
        date,
        description: desc.trim(),
        status: "done",
        fromAccountId: fromId,
        toAccountId: toId || spends?.id || "",
        amountPaise: paise,
        tag: tag.trim() || null,
        notes: note.trim() || null,
      });
      onError(null);
      await onDone();
      setDesc("");
      setAmount("");
      setTag("");
      setNote("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <>
      <tr className="bg-ledger-soft/50" onKeyDown={(e) => e.key === "Enter" && submit()}>
        <td><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></td>
        <td><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="New entry… (Enter saves)" /></td>
        <td>
          <div className="flex items-center">
            <AccountSelect value={fromId} onChange={setFromId} choices={fromChoices}
              placeholder="from…" className="w-1/2" />
            <span className="text-ink-faint text-xs">→</span>
            <AccountSelect value={toId} choices={toChoices} allowCreate placeholder="Spends"
              onChange={(v) => (v === NEW_CATEGORY ? setNewCatOpen(true) : setToId(v))}
              className="w-1/2" />
          </div>
        </td>
        <td><input value={amount} onChange={(e) => setAmount(e.target.value)}
          placeholder="₹" inputMode="decimal" className="text-right amount" /></td>
        <td><input value={tag} onChange={(e) => setTag(e.target.value)} list="known-tags"
          placeholder="tag" className="text-xs" /></td>
        <td><input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="note" className="text-xs" /></td>
        <td className="text-right">
          <button onClick={submit} className="text-ledger text-xs font-medium px-2 py-1.5 hover:underline">
            Add ↵
          </button>
        </td>
      </tr>
      <InputModal
        open={newCatOpen}
        title="New category"
        label="Category name (e.g. Swiggy, Transport, Groceries)"
        placeholder="Category"
        submitLabel="Create"
        onSubmit={createCategory}
        onClose={() => setNewCatOpen(false)}
      />
    </>
  );
}

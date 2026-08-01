"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { createEntry, rewriteEntry, type EntryInput } from "@/lib/postings";
import { Amount } from "@/components/amount";
import { AccountSelect, NEW_CATEGORY } from "@/components/account-select";
import { Select } from "@/components/select";
import { TitleInput, useTitleSuggestions } from "@/components/title-input";
import { DateInput } from "@/components/date-input";
import { InputModal, Modal } from "@/components/modal";
import { AccountModal, BLOCK_OPTIONS } from "@/components/account-modal";
import { CategoriesModal } from "@/components/categories-modal";
import { PersonModal } from "@/components/person-modal";
import { TemplateModal } from "@/components/template-form";
import { formatPaise, parseRupees } from "@/lib/money";
import { subtreeBalance, toISODate } from "@/lib/ledger";
import { emiActive, emiInfo, fmtMonth } from "@/lib/emi";
import { ArrowLeftRight, HandCoins, Pencil, Plus, RotateCcw, Scale, Settings2, Users } from "lucide-react";
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
interface ReceiveTarget {
  personId: string;
  amountPaise: number;
  label: string;
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
  const [receiveModal, setReceiveModal] = useState<ReceiveTarget | null>(null);
  const [receiveAmt, setReceiveAmt] = useState("");
  const [receiveBank, setReceiveBank] = useState("");
  const [reconFor, setReconFor] = useState<Account | null>(null);
  const [addPersonOpen, setAddPersonOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  // folded-in tab features: account CRUD, categories, person history, template edit
  const [acctModal, setAcctModal] = useState<{ editing: Account | null; optionIdxs?: number[] } | null>(null);
  const [catOpen, setCatOpen] = useState(false);
  const [personView, setPersonView] = useState<Account | null>(null);
  const [tplEdit, setTplEdit] = useState<RecurringTemplate | null>(null);
  const [splitFor, setSplitFor] = useState<TxnRow | null>(null);
  const [coverFor, setCoverFor] = useState<TxnRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openingOpen, setOpeningOpen] = useState(false);
  const [minMonth, setMinMonth] = useState<string | null>(null);

  const today = toISODate(new Date());
  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const banks = useMemo(
    () => active.filter((a) => a.is_liquid),
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

  // earliest logged month bounds backward navigation — no empty pre-history months
  useEffect(() => {
    supabase
      .from("transactions")
      .select("date")
      .order("date")
      .limit(1)
      .then(({ data }) => {
        setMinMonth((data?.[0]?.date ?? toISODate(new Date())).slice(0, 7));
      });
  }, [supabase]);

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
    const touchesEquity = t.postings.some(
      (p) => accountById(accounts, p.account_id)?.kind === "equity"
    );
    rows.push({
      kind: "txn",
      date: t.date,
      txn: t,
      fromId: negs[0]?.account_id ?? null,
      toId: to?.account_id ?? null,
      amountPaise: negs.length === 1
        ? -negs[0].amount_paise
        : pos.reduce((s, p) => s + p.amount_paise, 0),
      complex: negs.length !== 1 || touchesEquity,
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
  // EMIs outside their window (ended / not yet started) don't project into this month
  const monthTemplates = templates.filter((t) => emiActive(t, month));
  // past months show only what was actually logged — no projected/receive rows
  const isPastMonth = month < today.slice(0, 7);
  for (const t of isPastMonth ? [] : monthTemplates) {
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
  // opening/equity entries collapse into a single summary row on top
  const isOpening = (r: Row) =>
    r.kind === "txn" &&
    r.txn.postings.some((p) => accountById(accounts, p.account_id)?.kind === "equity");
  const openingRows = rows.filter(isOpening) as TxnRow[];
  const monthRows = rows.filter((r) => !isOpening(r));
  monthRows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // ---- summary
  const isIncomeT = (t: RecurringTemplate) =>
    accountById(accounts, t.from_account_id)?.kind === "income";
  const isInternalT = (t: RecurringTemplate) => {
    if (t.is_budget) return false; // budget moves are committed spend
    const from = accountById(accounts, t.from_account_id);
    const to = accountById(accounts, t.to_account_id);
    return from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";
  };
  const plannedIn = monthTemplates.filter(isIncomeT).reduce((s, t) => s + t.amount_paise, 0);
  // cash committed: only templates that take money from bank/cash this month —
  // card-charged items cost cash later, via the card bill (counted in card owed)
  const committed = monthTemplates
    .filter((t) => {
      if (isIncomeT(t) || isInternalT(t)) return false;
      return accountById(accounts, t.from_account_id)?.subtype !== "credit_card";
    })
    .reduce((s, t) => s + t.amount_paise, 0);
  const expectedBack = monthTemplates.reduce((s, t) => s + (t.reimburse_amount_paise ?? 0), 0);
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

  function openReceive(target: ReceiveTarget) {
    setReceiveAmt(target.amountPaise > 0 ? String(target.amountPaise / 100) : "");
    setReceiveBank(banks[0]?.id ?? "");
    setReceiveModal(target);
  }

  async function recordReceive() {
    if (!receiveModal) return;
    const paise = parseRupees(receiveAmt);
    if (!paise || paise <= 0 || !receiveBank) return;
    try {
      await createEntry(supabase, {
        date: today,
        description: receiveModal.label,
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

  async function reconcile(a: Account, input: string) {
    const paise = parseRupees(input);
    if (paise === null) return;
    const signed = a.kind === "liability" ? -paise : paise;
    await supabase
      .from("accounts")
      .update({ reported_balance_paise: signed, reported_at: new Date().toISOString() })
      .eq("id", a.id);
    await reload();
  }

  async function addPerson(name: string) {
    if (!name.trim()) return;
    const { error: e } = await supabase.from("accounts").insert({
      name: name.trim(),
      kind: "asset",
      subtype: "receivable",
      person_name: name.trim(),
    });
    if (e) setError(e.message);
    else await reload();
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

  const currentMonth = today.slice(0, 7);
  const canPrev = minMonth !== null && month > minMonth;
  const canNext = month < currentMonth; // Book stops at today — Plan owns the future

  function shiftMonth(delta: number) {
    const [y, m] = month.split("-").map(Number);
    const next = toISODate(new Date(y, m - 1 + delta, 1)).slice(0, 7);
    if (minMonth !== null && next < minMonth) return;
    if (next > currentMonth) return;
    setMonth(next);
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
          <button onClick={() => shiftMonth(-1)} disabled={!canPrev}
            className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft disabled:opacity-30 disabled:hover:bg-transparent">←</button>
          <h1 className="text-3xl w-[250px] text-center whitespace-nowrap">{monthName}</h1>
          <button onClick={() => shiftMonth(1)} disabled={!canNext}
            className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft disabled:opacity-30 disabled:hover:bg-transparent">→</button>
        </div>
        <div className="flex gap-5 text-sm flex-wrap">
          <Headline label="in" paise={plannedIn} cls="text-ledger" />
          <Headline label="cash committed" paise={committed} />
          <Headline label="card due" paise={totalDue} cls={totalDue > 0 ? "text-debit" : ""} />
          <Headline label="card owed" paise={totalCardOwed} cls={totalCardOwed > 0 ? "text-debit" : ""} />
          <Headline label="coming back" paise={expectedBack} cls="text-ledger" />
          <button onClick={() => setLeftOpen(true)} title="How is this calculated?" className="text-right">
            <Headline label="left ⓘ" paise={plannedIn - committed - totalCardOwed + expectedBack} cls={plannedIn - committed - totalCardOwed + expectedBack >= 0 ? "text-ledger" : "text-debit"} />
          </button>
          {avoidable > 0 && <Headline label="avoidable" paise={avoidable} cls="text-pending" />}
        </div>
      </div>

      {error && <p className="text-sm text-debit border border-debit-soft bg-debit-soft px-3 py-2">{error}</p>}

      <div className="grid xl:grid-cols-[1fr_310px] gap-5 items-start">
        {/* ledger */}
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
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              <QuickAddRow accounts={active} supabase={supabase} onDone={refreshAll} onError={setError} />
              {openingRows.length > 0 && (
                <tr className="bg-paper">
                  <td className="px-2 py-1.5 amount text-ink-faint whitespace-nowrap">
                    {fmtDate(openingRows[0].date)}
                  </td>
                  <td className="px-2 py-1.5 text-ink-soft" colSpan={2}>
                    <button onClick={() => setOpeningOpen((v) => !v)}
                      className="hover:text-ledger">
                      Opening entries · {openingRows.length} · {openingOpen ? "hide" : "show"}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 text-right amount text-ink-faint">—</td>
                  <td colSpan={3}></td>
                </tr>
              )}
              {openingOpen && openingRows.map((row) => (
                <TxnEditRow
                  key={"o" + row.txn.id}
                  row={row}
                  accounts={accounts}
                  active={active}
                  today={today}
                  expanded={expanded === row.txn.id}
                  onToggleExpand={() => setExpanded(expanded === row.txn.id ? null : row.txn.id)}
                  onSplit={() => setSplitFor(row)}
                  onCover={() => setCoverFor(row)}
                  onSave={saveEdit}
                  onPatch={patchTxn}
                  onDelete={() => remove(row)}
                />
              ))}
              {monthRows.map((row) => {
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
                        {(() => {
                          const e = emiInfo(t, month);
                          return e ? (
                            <span className="text-[11px] text-ink-faint"> · EMI {e.idx}/{e.total} · ends {fmtMonth(e.endISO)}</span>
                          ) : null;
                        })()}
                        {overdue && <span className="text-xs text-debit font-medium"> · overdue</span>}
                      </td>
                      <td className="px-0 py-2 text-xs text-ink-faint">
                        <div className="flex items-center">
                          <span className="w-1/2 px-2">{from?.name}</span>
                          <span>{internal ? "⇄" : "→"}</span>
                          <span className="w-1/2 px-2">{toAcc?.name}</span>
                        </div>
                      </td>
                      <td className={`${cellCls} text-right`}>
                        <Amount paise={isIn ? t.amount_paise : internal ? t.amount_paise : -t.amount_paise}
                          signed={!internal} className={internal ? "text-ink-faint" : ""} />
                      </td>
                      <td className={cellCls}></td>
                      <td className={cellCls}></td>
                      <td className={`${cellCls} text-right whitespace-nowrap`}>
                        <IconBtn title={`Edit "${t.name}"`} onClick={() => setTplEdit(t)}>
                          <Pencil size={13} />
                        </IconBtn>
                        <button onClick={() => setPostModal(t)}
                          className={`text-xs border px-2 py-1 whitespace-nowrap ml-1 ${overdue ? "border-debit text-debit hover:bg-debit-soft" : "border-ledger text-ledger hover:bg-ledger-soft"}`}>
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
                      <td className="px-0 py-2 text-xs text-ink-faint">
                        <div className="flex items-center">
                          <span className="w-1/2 px-2">{person?.name}</span>
                          <span>→</span>
                          <span className="w-1/2 px-2">you</span>
                        </div>
                      </td>
                      <td className={`${cellCls} text-right`}>
                        <Amount paise={row.amountPaise} signed className="text-ledger" />
                      </td>
                      <td className={cellCls}></td>
                      <td className={cellCls}></td>
                      <td className={`${cellCls} text-right`}>
                        {!row.received && (
                          <button onClick={() => openReceive({
                            personId: row.personId,
                            amountPaise: row.amountPaise,
                            label: `${accountById(accounts, row.personId)?.name} repays ${row.template.name}`,
                          })}
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
                    expanded={expanded === row.txn.id}
                    onToggleExpand={() => setExpanded(expanded === row.txn.id ? null : row.txn.id)}
                    onSplit={() => setSplitFor(row)}
                    onCover={() => setCoverFor(row)}
                    onSave={saveEdit}
                    onPatch={patchTxn}
                    onDelete={() => remove(row)}
                  />
                );
              })}
            </tbody>
          </table>
          {monthRows.length === 0 && openingRows.length === 0 && (
            <p className="text-sm text-ink-faint p-4">
              {isPastMonth
                ? "Nothing was logged this month — past months show only real entries, nothing projected."
                : "Empty month — add an entry above."}
            </p>
          )}
        </div>

        {/* sidebar */}
        <aside className="space-y-4">
          <SideBlock title="Accounts"
            action={<span className="flex items-center gap-1">
              <IconBtn title="Manage categories & income" onClick={() => setCatOpen(true)}>
                <Settings2 size={13} />
              </IconBtn>
              <IconBtn title="Add bank / envelope / cash" onClick={() => setAcctModal({ editing: null, optionIdxs: BLOCK_OPTIONS.accounts })}>
                <Plus size={13} />
              </IconBtn>
            </span>}>
            {active.filter((a) => ["bank", "cash"].includes(a.subtype)).map((b) => {
              const total = subtreeBalance(accounts, balances, b.id);
              const own = balances.get(b.id)?.balance_paise ?? 0;
              const envs = active.filter((e) => e.parent_id === b.id);
              const gap = b.reported_balance_paise !== null ? b.reported_balance_paise - total : null;
              return (
                <div key={b.id}>
                  <div className="px-3 py-1.5 flex items-center justify-between gap-2">
                    <div>
                      <button onClick={() => setAcctModal({ editing: b })}
                        className="text-sm text-left hover:text-ledger" title={`Edit ${b.name}`}>
                        {b.name}
                      </button>
                      {envs.length > 0 && (
                        <p className="text-[11px] text-ink-faint">free {formatPaise(own)}</p>
                      )}
                      {gap !== null && gap !== 0 && (
                        <p className="text-[11px] text-debit">
                          {gap > 0 ? "+" : ""}{formatPaise(gap)} vs bank
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Amount paise={total} />
                      <IconBtn title={`Reconcile ${b.name}`} onClick={() => setReconFor(b)}>
                        <Scale size={13} />
                      </IconBtn>
                    </div>
                  </div>
                  {envs.map((env) => (
                    <div key={env.id} className="pl-6 pr-9 py-1 flex items-baseline justify-between gap-2">
                      <button onClick={() => setAcctModal({ editing: env })}
                        className="text-xs text-ink-soft text-left hover:text-ledger" title={`Edit ${env.name}`}>
                        ↳ {env.name}
                      </button>
                      <Amount paise={balances.get(env.id)?.balance_paise ?? 0} className="text-xs" />
                    </div>
                  ))}
                </div>
              );
            })}
          </SideBlock>

          <SideBlock title="Cards"
            action={<IconBtn title="Add card / sub-card" onClick={() => setAcctModal({ editing: null, optionIdxs: BLOCK_OPTIONS.cards })}>
              <Plus size={13} />
            </IconBtn>}>
            {parentCards.map((c) => {
              const due = cardDueNow(c);
              const unbilled = cardUnbilled(c);
              const owed = due + unbilled;
              const subs = active.filter((s) => s.parent_id === c.id);
              const gap = c.reported_balance_paise !== null ? -c.reported_balance_paise - owed : null;
              return (
                <div key={c.id} className="px-3 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <button onClick={() => setAcctModal({ editing: c })}
                      className="text-sm text-left hover:text-ledger" title={`Edit ${c.name}`}>
                      {c.name}
                    </button>
                    <div className="flex items-center gap-1.5">
                      <Amount paise={owed} className={owed > 0 ? "text-debit" : "text-ink-faint"} />
                      <IconBtn title={`Reconcile ${c.name}`} onClick={() => setReconFor(c)}>
                        <Scale size={13} />
                      </IconBtn>
                    </div>
                  </div>
                  <p className="text-[11px] text-ink-faint">
                    {due > 0 && <>due {formatPaise(due)} by the {ordinal(c.due_day)} · </>}
                    {unbilled > 0
                      ? <>{formatPaise(unbilled)} unbilled — bills on the {ordinal(c.statement_day)}</>
                      : due > 0 ? null : "nothing owed"}
                  </p>
                  {subs.length > 0 && owed > 0 && (
                    <p className="text-[11px] text-ink-faint">
                      incl. {subs.map((s) => s.name).join(", ")}
                    </p>
                  )}
                  {gap !== null && gap !== 0 && (
                    <p className="text-[11px] text-debit">
                      {formatPaise(Math.abs(gap))} {gap > 0 ? "unlogged on card" : "over-logged"}
                    </p>
                  )}
                </div>
              );
            })}
          </SideBlock>

          <SideBlock title="People"
            action={<IconBtn title="Add person" onClick={() => setAddPersonOpen(true)}>
              <Plus size={13} />
            </IconBtn>}>
            {(() => {
              const all = active
                .filter((a) => a.subtype === "receivable")
                .map((p) => ({ p, bal: balances.get(p.id)?.balance_paise ?? 0 }));
              const owing = all.filter((x) => x.bal !== 0);
              const settled = all.filter((x) => x.bal === 0);
              return (
                <>
                  {owing.map(({ p, bal }) => (
                    <div key={p.id} className="px-3 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <button onClick={() => setPersonView(p)}
                          className="text-sm text-left hover:text-ledger" title={`${p.name} — full ledger`}>
                          {p.name}
                        </button>
                        <div className="flex items-center gap-1.5">
                          <Amount paise={Math.abs(bal)} className={bal > 0 ? "text-ledger" : "text-debit"} />
                          {bal > 0 && (
                            <IconBtn title={`Record money received from ${p.name}`}
                              onClick={() => openReceive({
                                personId: p.id,
                                amountPaise: bal,
                                label: `Received from ${p.name}`,
                              })}>
                              <HandCoins size={13} />
                            </IconBtn>
                          )}
                        </div>
                      </div>
                      <p className="text-[11px] text-ink-faint">{bal > 0 ? "owes you" : "you owe"}</p>
                    </div>
                  ))}
                  {settled.length > 0 && (
                    <p className="px-3 py-1.5 text-[11px] text-ink-faint">
                      settled:{" "}
                      {settled.map(({ p }, i) => (
                        <span key={p.id}>
                          {i > 0 && ", "}
                          <button onClick={() => setPersonView(p)}
                            className="hover:text-ledger underline decoration-dotted"
                            title={`${p.name} — full ledger`}>
                            {p.name}
                          </button>
                        </span>
                      ))}
                    </p>
                  )}
                  {all.length === 0 && (
                    <p className="px-3 py-1.5 text-xs text-ink-faint">No people yet.</p>
                  )}
                </>
              );
            })()}
          </SideBlock>

          <SideBlock title="Investments"
            action={<IconBtn title="Add investment" onClick={() => setAcctModal({ editing: null, optionIdxs: BLOCK_OPTIONS.investments })}>
              <Plus size={13} />
            </IconBtn>}>
            {active.filter((a) => a.subtype === "investment").map((v) => (
              <div key={v.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
                <button onClick={() => setAcctModal({ editing: v })}
                  className="text-sm text-left hover:text-ledger" title={`Edit ${v.name}`}>
                  {v.name}
                </button>
                <div className="flex items-center gap-1.5">
                  <Amount paise={balances.get(v.id)?.balance_paise ?? 0} />
                  <IconBtn title={`Reconcile ${v.name}`} onClick={() => setReconFor(v)}>
                    <Scale size={13} />
                  </IconBtn>
                </div>
              </div>
            ))}
          </SideBlock>

          <SideBlock title="Loans"
            action={<IconBtn title="Add loan" onClick={() => setAcctModal({ editing: null, optionIdxs: BLOCK_OPTIONS.loans })}>
              <Plus size={13} />
            </IconBtn>}>
            {active.filter((a) => a.subtype === "loan").map((l) => (
              <div key={l.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
                <button onClick={() => setAcctModal({ editing: l })}
                  className="text-sm text-left hover:text-ledger" title={`Edit ${l.name}`}>
                  {l.name}
                </button>
                <div className="flex items-center gap-1.5">
                  <Amount paise={-(balances.get(l.id)?.balance_paise ?? 0)} />
                  <IconBtn title={`Reconcile ${l.name}`} onClick={() => setReconFor(l)}>
                    <Scale size={13} />
                  </IconBtn>
                </div>
              </div>
            ))}
          </SideBlock>
        </aside>
      </div>

      <Modal open={leftOpen} title="How 'left' is calculated" onClose={() => setLeftOpen(false)}>
        <div className="text-sm space-y-2">
          <CalcLine label="Money coming in (salary templates)" paise={plannedIn} sign="+" />
          <CalcLine label="Cash committed — recurring paid from banks/cash this month (card-charged items excluded: their cash cost is in the card bill)" paise={committed} sign="−" />
          <CalcLine label="Card owed — full outstanding you'll pay via bills" paise={totalCardOwed} sign="−" />
          <CalcLine label="Coming back — expected repayments this month" paise={expectedBack} sign="+" />
          <div className="border-t border-rule-strong pt-2">
            <CalcLine label="Left" paise={plannedIn - committed - totalCardOwed + expectedBack} sign="=" bold />
          </div>
          <p className="text-xs text-ink-faint pt-1">
            This is planning money, not a bank balance: what remains of the
            month&apos;s income after every known commitment, if you clear all
            card debt. Ad-hoc spends you log during the month are not
            subtracted here — watch the account balances for that.
          </p>
        </div>
      </Modal>

      <InputModal
        open={reconFor !== null}
        title={reconFor ? `Reconcile ${reconFor.name}` : ""}
        label={reconFor?.kind === "liability"
          ? "Actual outstanding from the card/bank app (₹)"
          : "Actual balance from the bank app (₹)"}
        placeholder="0"
        submitLabel="Save"
        onSubmit={async (v) => {
          if (reconFor) await reconcile(reconFor, v);
        }}
        onClose={() => setReconFor(null)}
      />

      <InputModal
        open={addPersonOpen}
        title="New person"
        label="Anyone who owes you or borrows through you"
        placeholder="Name"
        submitLabel="Add"
        onSubmit={addPerson}
        onClose={() => setAddPersonOpen(false)}
      />

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
        title={receiveModal?.label ?? ""}
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
        <div className="mt-2">
          <Select chrome value={receiveBank} onChange={setReceiveBank} placeholder="into…"
            groups={[{ options: banks.map((b) => ({ value: b.id, label: `into ${b.name}` })) }]} />
        </div>
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

      {acctModal && (
        <AccountModal
          open
          editing={acctModal.editing}
          optionIdxs={acctModal.optionIdxs}
          onDone={refreshAll}
          onClose={() => setAcctModal(null)}
        />
      )}

      <CategoriesModal
        open={catOpen}
        accounts={accounts}
        balances={balances}
        onEdit={(a) => setAcctModal({ editing: a })}
        onNew={() => setAcctModal({ editing: null, optionIdxs: [8, 9] })}
        onClose={() => setCatOpen(false)}
      />

      <PersonModal
        person={personView}
        balancePaise={personView ? balances.get(personView.id)?.balance_paise ?? 0 : 0}
        onClose={() => setPersonView(null)}
      />

      <TemplateModal
        open={tplEdit !== null}
        accounts={active}
        editing={tplEdit}
        onSaved={async () => {
          setTplEdit(null);
          await refreshAll();
        }}
        onClose={() => setTplEdit(null)}
      />

      <CoverModal
        row={coverFor}
        accounts={active}
        onSave={async (sourceId, paise) => {
          if (!coverFor?.fromId) return;
          try {
            await createEntry(supabase, {
              date: today,
              description: `Cover: ${coverFor.txn.description}`,
              status: "done",
              fromAccountId: sourceId,
              toAccountId: coverFor.fromId,
              amountPaise: paise,
            });
            setError(null);
            setCoverFor(null);
            await refreshAll();
          } catch (e) {
            setError(e instanceof Error ? e.message : "failed");
          }
        }}
        onClose={() => setCoverFor(null)}
      />

      <SplitModal
        row={splitFor}
        people={active.filter((a) => a.subtype === "receivable")}
        onSave={async (personId, paise) => {
          if (!splitFor) return;
          await saveEdit(splitFor, {
            reimburseAccountId: personId,
            reimbursePaise: personId ? paise : null,
          });
          setSplitFor(null);
        }}
        onClose={() => setSplitFor(null)}
      />
    </div>
  );
}

function CoverModal({
  row, accounts, onSave, onClose,
}: {
  row: TxnRow | null;
  accounts: Account[];
  onSave: (sourceId: string, paise: number) => Promise<void>;
  onClose: () => void;
}) {
  const [sourceId, setSourceId] = useState("");
  const [amt, setAmt] = useState("");
  const txnId = row?.txn.id;

  useEffect(() => {
    if (!row) return;
    setSourceId("");
    setAmt(String(row.amountPaise / 100));
    // re-seed whenever a different row opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txnId]);

  if (!row) return null;
  const target = accountById(accounts, row.fromId);
  const sources = accounts.filter(
    (a) => a.is_liquid && a.id !== row.fromId
  );
  const paise = parseRupees(amt);
  return (
    <Modal open title={`Cover "${row.txn.description}"`} onClose={onClose}>
      <p className="text-xs text-ink-soft mb-2">
        {target?.name} paid this as a stand-in — record the transfer that
        refills it from the account that was really meant to pay.
      </p>
      <Select chrome value={sourceId} onChange={setSourceId} placeholder="Pull funds from…"
        groups={[{ options: sources.map((a) => ({ value: a.id, label: `${a.name} → ${target?.name}` })) }]} />
      <input value={amt} onChange={(e) => setAmt(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && sourceId && paise && paise > 0 && onSave(sourceId, paise)}
        inputMode="decimal" placeholder="Amount ₹"
        className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount mt-2" />
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="text-sm text-ink-soft px-3 py-1.5 hover:text-ink">
          Cancel
        </button>
        <button
          onClick={() => sourceId && paise && paise > 0 && onSave(sourceId, paise)}
          disabled={!sourceId || !paise || paise <= 0}
          className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90 disabled:opacity-50">
          Record transfer
        </button>
      </div>
    </Modal>
  );
}

function SplitModal({
  row, people, onSave, onClose,
}: {
  row: TxnRow | null;
  people: Account[];
  onSave: (personId: string | null, paise: number | null) => Promise<void>;
  onClose: () => void;
}) {
  const [personId, setPersonId] = useState("");
  const [amt, setAmt] = useState("");
  const txnId = row?.txn.id;

  useEffect(() => {
    if (!row) return;
    setPersonId(row.txn.reimburse_account_id ?? "");
    setAmt(row.txn.reimburse_amount_paise ? String(row.txn.reimburse_amount_paise / 100) : "");
    // re-seed whenever a different row opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txnId]);

  if (!row) return null;
  const paise = parseRupees(amt);
  return (
    <Modal open title={`Split "${row.txn.description}"`} onClose={onClose}>
      <p className="text-xs text-ink-soft mb-2">
        Their share is added to what they owe you; your expense shrinks by the same amount.
      </p>
      <Select chrome value={personId} onChange={setPersonId} placeholder="No split"
        groups={[{ options: [{ value: "", label: "No split" },
          ...people.map((p) => ({ value: p.id, label: p.name }))] }]} />
      {personId && (
        <input value={amt} onChange={(e) => setAmt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSave(personId, paise)}
          inputMode="decimal" placeholder="Their share ₹"
          className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount mt-2" />
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="text-sm text-ink-soft px-3 py-1.5 hover:text-ink">
          Cancel
        </button>
        <button
          onClick={() => onSave(personId || null, paise)}
          disabled={!!personId && (!paise || paise <= 0 || paise >= row.amountPaise)}
          className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90 disabled:opacity-50">
          Save
        </button>
      </div>
    </Modal>
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

function IconBtn({
  title, onClick, children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className="text-ink-faint hover:text-ledger p-0.5 shrink-0">
      {children}
    </button>
  );
}

function ordinal(n: number | null): string {
  if (n === null) return "—";
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function SideBlock({
  title, action, children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-rule bg-paper-raised">
      <div className="flex items-baseline justify-between px-3 pt-2 pb-1">
        <p className="text-[10px] uppercase tracking-[0.15em] text-ink-faint">{title}</p>
        {action}
      </div>
      <div className="divide-y divide-rule/60 pb-1">{children}</div>
    </div>
  );
}

function TxnEditRow({
  row, accounts, active, today, expanded, onToggleExpand, onSplit, onCover, onSave, onPatch, onDelete,
}: {
  row: TxnRow;
  accounts: Account[];
  active: Account[];
  today: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onSplit: () => void;
  onCover: () => void;
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

  if (row.complex) {
    // multi-leg entry (e.g. opening balances) — read-only so it can't be mangled
    return (
      <>
        <tr className="bg-paper">
          <td className="px-2 py-1.5 amount text-ink-faint whitespace-nowrap">{fmtDate(t.date)}</td>
          <td className="px-2 py-1.5 text-ink-soft">{t.description}</td>
          <td className="px-2 py-1.5 text-xs">
            <button onClick={onToggleExpand} className="text-ink-faint hover:text-ledger">
              {t.postings.length <= 3
                ? "opening entry"
                : `${t.postings.length} accounts`} · {expanded ? "hide" : "show"}
            </button>
          </td>
          <td className="px-2 py-1.5 text-right amount text-ink-faint">
            {t.postings.length <= 3 ? formatPaise(row.amountPaise) : "—"}
          </td>
          <td className="px-2 py-1.5"></td>
          <td className="px-2 py-1.5 text-xs text-ink-faint">{t.notes ?? ""}</td>
          <td className="px-2 py-1.5 text-right">
            <button onClick={onDelete} className="text-ink-faint hover:text-debit">×</button>
          </td>
        </tr>
        {expanded &&
          [...t.postings]
            .sort((a, b) => b.amount_paise - a.amount_paise)
            .map((p) => (
              <tr key={p.id} className="bg-paper">
                <td></td>
                <td className="px-2 py-1 pl-6 text-xs text-ink-faint">
                  ↳ {accountById(accounts, p.account_id)?.name}
                </td>
                <td></td>
                <td className="px-2 py-1 text-right">
                  <Amount paise={p.amount_paise} signed className="text-xs" />
                </td>
                <td colSpan={3}></td>
              </tr>
            ))}
      </>
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
        <DateInput value={t.date} onChange={(iso) => onSave(row, { date: iso })}
          className="text-ink-faint" />
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
        {pending ? (
          <button onClick={() => onPatch(t.id, { status: "done", date: today })}
            className="text-xs text-ledger hover:underline mr-1">paid</button>
        ) : (
          <IconBtn title="Mark pending again" onClick={() => onPatch(t.id, { status: "pending" })}>
            <RotateCcw size={12} />
          </IconBtn>
        )}
        <IconBtn
          title={t.reimburse_account_id
            ? `Split: ${accountById(accounts, t.reimburse_account_id)?.name} owes ${formatPaise(t.reimburse_amount_paise ?? 0)}`
            : "Split with someone (they owe part)"}
          onClick={onSplit}>
          <Users size={12} className={t.reimburse_account_id ? "text-ledger" : undefined} />
        </IconBtn>
        {from?.is_liquid && (
          <IconBtn title={`Paid from ${from.name} as a stand-in? Pull the money over from another account`}
            onClick={onCover}>
            <ArrowLeftRight size={12} />
          </IconBtn>
        )}
        <button onClick={onDelete} className="text-ink-faint hover:text-debit ml-1">×</button>
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
  const [planned, setPlanned] = useState<boolean | null>(null); // null = follow the date
  const suggestions = useTitleSuggestions(supabase);

  const isPlanned = planned ?? date > toISODate(new Date());

  const fromChoices = accounts.filter((a) =>
    ["bank", "envelope", "cash", "investment", "credit_card", "receivable", "salary", "other_income"].includes(a.subtype)
  );
  const toChoices = accounts.filter((a) =>
    !["salary", "other_income", "opening_balance"].includes(a.subtype)
  );
  const defaultCat = accounts.find((a) => a.kind === "expense"); // first category = default destination

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
        status: isPlanned ? "pending" : "done",
        fromAccountId: fromId,
        toAccountId: toId || defaultCat?.id || "",
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
      setPlanned(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <>
      <tr className="bg-ledger-soft/50" onKeyDown={(e) => e.key === "Enter" && submit()}>
        <td>
          <DateInput value={date} onChange={setDate} />
        </td>
        <td>
          <TitleInput value={desc} onChange={setDesc} suggestions={suggestions}
            placeholder="New entry… (Enter saves)"
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
            <AccountSelect value={toId} choices={toChoices} allowCreate placeholder={defaultCat?.name ?? "category…"}
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
        <td className="text-right whitespace-nowrap">
          <button onClick={() => setPlanned(!isPlanned)}
            title={isPlanned
              ? "Will save as planned (pending) — click to save as done instead"
              : "Will save as done — click to save as planned (pending) instead"}
            className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 border mr-1 ${isPlanned
              ? "border-pending text-pending bg-pending-soft/60"
              : "border-rule text-ink-faint hover:text-pending"}`}>
            {isPlanned ? "planned" : "done"}
          </button>
          <button onClick={submit} className="text-ledger text-xs font-medium px-2 py-1.5 hover:underline">
            {isPlanned ? "Plan ↵" : "Add ↵"}
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

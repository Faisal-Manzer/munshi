"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLedger, accountById } from "@/lib/use-ledger";
import { decryptPosting, decryptTemplate, decryptTransaction } from "@munshi/store";
import { amountMatches, createEntry, emiActive, emiInfo, fmtMonth, formatPaise, parseRupees, rewriteEntry, subtreeBalance, toISODate } from "@munshi/core";
import type { EntryInput } from "@munshi/core";
import { Amount } from "@/components/amount";
import { AccountSelect, NEW_CATEGORY, NEW_INCOME, accountGroups } from "@/components/account-select";
import { Select } from "@/components/select";
import { TitleInput, useTitleSuggestions } from "@/components/title-input";
import { DateInput } from "@/components/date-input";
import { Field } from "@/components/field";
import { Headline } from "@/components/headline";
import { SideBlock } from "@/components/side-block";
import { InputModal, Modal } from "@/components/modal";
import { AccountModal, BLOCK_OPTIONS } from "@/components/account-modal";
import { AccountSheet } from "@/components/account-sheet";
import { CategoriesModal } from "@/components/categories-modal";
import { ReconcileModal } from "@/components/reconcile-modal";
import { TemplateModal } from "@/components/template-form";
import {
  cardDueNow as cardDueNowOf,
  cardUnbilled as cardUnbilledOf,
  isIncomeTemplate,
  isInternalTemplate,
  liquidNowOf,
  liquidOutlook,
  monthActuals,
  oneOffAmount,
  oneOffKind,
  parentCardsOf,
} from "@munshi/core";
import { ArrowDownLeft, ArrowLeftRight, ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, Search, Settings2, Users, X } from "lucide-react";
import {
  DEFAULT_TAGS,
  type Account,
  type Posting,
  type RecurringTemplate,
  type Transaction,
} from "@munshi/core";

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
  id: string;
  name: string; // what is being repaid
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

/**
 * Numeric search: "520.65" is exact; an integer matches at the precision its
 * trailing zeros imply — "520" hits 520.00–520.99, "500" hits 500–599.99,
 * commas and ₹ ignored.
 */
function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

function PageSkeleton() {
  return (
    <div className="space-y-5" aria-busy title="Loading…">
      <div className="flex items-end justify-between gap-3">
        <div className="shimmer h-10 w-[330px]" />
        <div className="shimmer h-8 w-[420px]" />
      </div>
      <div className="flex gap-2">
        <div className="shimmer h-8 w-56" />
        <div className="shimmer h-8 w-44" />
        <div className="shimmer h-8 w-32" />
        <div className="shimmer h-8 w-32" />
      </div>
      <div className="grid xl:grid-cols-[1fr_310px] gap-5 items-start">
        <div className="border border-rule bg-paper-raised p-2 space-y-2">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="shimmer h-8" style={{ opacity: 1 - i * 0.09 }} />
          ))}
        </div>
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="border border-rule bg-paper-raised p-3 space-y-2">
              <div className="shimmer h-3 w-24" />
              <div className="shimmer h-6" />
              <div className="shimmer h-6 w-3/4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function BookPage() {
  const { supabase, store, ledgerKey, keyReady, ledgerId, accounts, balances, cycles, loading, reload } = useLedger();
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
  const [detailFor, setDetailFor] = useState<"liquid" | "toPay" | "toReceive" | null>(null);
  // folded-in tab features: account CRUD, categories, entity detail, template edit
  const [createAcct, setCreateAcct] = useState<number[] | null>(null);
  const [catOpen, setCatOpen] = useState(false);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [tplEdit, setTplEdit] = useState<RecurringTemplate | null>(null);
  const [splitFor, setSplitFor] = useState<TxnRow | null>(null);
  const [coverFor, setCoverFor] = useState<TxnRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openingOpen, setOpeningOpen] = useState(false);
  const [minMonth, setMinMonth] = useState<string | null>(null);
  // sidebar tiles with sub-rows are collapsed unless toggled open
  const [openTiles, setOpenTiles] = useState<Set<string>>(new Set());
  const toggleTile = (id: string) =>
    setOpenTiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // entries added this sitting stay pinned under the add row until the
  // month is left — batch entry never has rows jumping into the middle
  const [justAdded, setJustAdded] = useState<string[]>([]);
  useEffect(() => setJustAdded([]), [month]);
  // ledger filter/search
  const [query, setQuery] = useState("");
  const [fAcct, setFAcct] = useState("");
  const [fTag, setFTag] = useState("");
  const [fStatus, setFStatus] = useState(""); // "" | done | pending | projected

  const today = toISODate(new Date());
  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const banks = useMemo(
    () => active.filter((a) => a.is_liquid),
    [active]
  );

  const load = useCallback(async () => {
    if (!ledgerId) return;
    // the key resolves a tick after the ledger id does; loading in that gap
    // would hit encrypted rows with no key and raise a false "locked" error
    if (!keyReady) return;
    const start = `${month}-01`;
    const end = toISODate(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    const [xRes, tRes] = await Promise.all([
      supabase
        .from("transactions")
        .select("*, postings(*)")
        .eq("ledger_id", ledgerId)
        .gte("date", start)
        .lt("date", end)
        .order("date")
        .order("created_at"),
      supabase
        .from("recurring_templates")
        .select("*")
        .eq("ledger_id", ledgerId)
        .eq("active", true),
    ]);
    if (xRes.error || tRes.error) {
      setError(xRes.error?.message ?? tRes.error?.message ?? "load failed");
      return;
    }
    try {
      setTxns(
        (xRes.data as (Transaction & { postings: Posting[] })[]).map((t) => ({
          ...decryptTransaction(ledgerKey, t),
          postings: t.postings.map((p) => decryptPosting(ledgerKey, p)),
        }))
      );
      setTemplates(
        (tRes.data as RecurringTemplate[]).map((t) => decryptTemplate(ledgerKey, t))
      );
      setError(null); // a good load clears whatever the last bad one said
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not decrypt this book");
    }
  }, [supabase, ledgerId, month, ledgerKey, keyReady]);

  useEffect(() => {
    load();
  }, [load]);

  // earliest logged month bounds backward navigation — no empty pre-history months
  useEffect(() => {
    if (!ledgerId) return;
    supabase
      .from("transactions")
      .select("date")
      .eq("ledger_id", ledgerId)
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

  // detail sheet is route-addressable: ?account=<id> survives reload/share
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("account");
    if (id) setSheetId(id);
  }, []);
  const openSheet = useCallback((id: string) => {
    setSheetId(id);
    const u = new URL(location.href);
    u.searchParams.set("account", id);
    window.history.replaceState(null, "", u);
  }, []);
  const closeSheet = useCallback(() => {
    setSheetId(null);
    const u = new URL(location.href);
    u.searchParams.delete("account");
    window.history.replaceState(null, "", u);
  }, []);

  // net spend per expense category this month — split credits and covers
  // post back to the category, so summing every leg keeps the number honest
  const catSpends = useMemo(() => {
    const totals = new Map<string, number>();
    for (const x of txns) {
      if (x.postings.some((p) => accountById(accounts, p.account_id)?.kind === "equity")) continue;
      for (const p of x.postings) {
        if (accountById(accounts, p.account_id)?.kind !== "expense") continue;
        totals.set(p.account_id, (totals.get(p.account_id) ?? 0) + p.amount_paise);
      }
    }
    return [...totals.entries()]
      .filter(([, paise]) => paise !== 0)
      .sort((a, b) => b[1] - a[1]);
  }, [txns, accounts]);
  const totalSpend = catSpends.reduce((s, [, paise]) => s + paise, 0);

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
        id: t.id,
        name: t.name,
        personId: t.reimburse_account_id,
        amountPaise: t.reimburse_amount_paise,
        received:
          (personCredits.get(t.reimburse_account_id) ?? 0) >= t.reimburse_amount_paise,
      });
    }
  }
  // splits recorded on entries themselves (e.g. loan EMI split per-txn) are
  // repayment expectations too — skip ones a template already projects
  for (const x of isPastMonth ? [] : txns) {
    if (!x.reimburse_account_id || !x.reimburse_amount_paise) continue;
    if (
      x.recurring_template_id &&
      monthTemplates.some((t) => t.id === x.recurring_template_id && t.reimburse_account_id)
    ) continue;
    rows.push({
      kind: "receive",
      date: x.date,
      id: "x" + x.id,
      name: x.description,
      personId: x.reimburse_account_id,
      amountPaise: x.reimburse_amount_paise,
      received:
        (personCredits.get(x.reimburse_account_id) ?? 0) >= x.reimburse_amount_paise,
    });
  }
  // opening/equity entries collapse into a single summary row on top
  const isOpening = (r: Row) =>
    r.kind === "txn" &&
    r.txn.postings.some((p) => accountById(accounts, p.account_id)?.kind === "equity");
  const openingRows = rows.filter(isOpening) as TxnRow[];
  let monthRows = rows.filter((r) => !isOpening(r));
  // newest first: the entry you just made, and the day you are living in, are
  // what you came to look at — history reads downward from there
  const kindRank = (r: Row) => (r.kind === "txn" ? 0 : r.kind === "virtual" ? 1 : 2);
  const seq = (r: Row) => (r.kind === "txn" ? (r.txn.created_at ?? "") : "");
  monthRows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (kindRank(a) !== kindRank(b)) return kindRank(a) - kindRank(b);
    return seq(a) < seq(b) ? 1 : seq(a) > seq(b) ? -1 : 0;
  });

  // ---- filter & search
  const filtering = Boolean(query.trim() || fAcct || fTag || fStatus);
  const totalRows = monthRows.length;
  if (filtering) {
    const q = query.trim().toLowerCase();
    const rowAccounts = (r: Row): (string | null)[] =>
      r.kind === "txn"
        ? r.txn.postings.map((p) => p.account_id)
        : r.kind === "virtual"
          ? [r.template.from_account_id, r.template.to_account_id, r.template.reimburse_account_id]
          : [r.personId];
    const rowText = (r: Row): string => {
      const names = rowAccounts(r)
        .map((id) => accountById(accounts, id)?.name ?? "")
        .join(" ");
      if (r.kind === "txn")
        return `${r.txn.description} ${r.txn.notes ?? ""} ${r.txn.tag ?? ""} ${names}`;
      if (r.kind === "virtual") return `${r.template.name} ${r.template.notes ?? ""} ${names}`;
      return `${r.name} ${names}`;
    };
    const rowStatus = (r: Row): string =>
      r.kind === "txn" ? r.txn.status : "projected";
    const rowAmounts = (r: Row): number[] =>
      r.kind === "txn"
        ? [r.amountPaise, ...r.txn.postings.map((p) => p.amount_paise)]
        : r.kind === "virtual"
          ? [r.template.amount_paise]
          : [r.amountPaise];
    monthRows = monthRows.filter((r) => {
      if (q && !rowText(r).toLowerCase().includes(q) &&
          !rowAmounts(r).some((a) => amountMatches(q, a))) return false;
      if (fAcct && !rowAccounts(r).includes(fAcct)) return false;
      if (fTag && !(r.kind === "txn" && r.txn.tag === fTag)) return false;
      if (fStatus && rowStatus(r) !== fStatus) return false;
      return true;
    });
  }

  // pinned just-added rows render first, in the order they were entered
  const pinnedRows = justAdded
    .map((id) => monthRows.find((r) => r.kind === "txn" && r.txn.id === id))
    .filter(Boolean) as TxnRow[];
  const restRows = monthRows.filter(
    (r) => !(r.kind === "txn" && justAdded.includes(r.txn.id))
  );
  const orderedRows = filtering ? monthRows : [...pinnedRows, ...restRows];

  // ---- summary
  const avoidable = txns
    .filter((t) => t.tag?.toLowerCase().includes("avoid"))
    .reduce((s, t) => {
      const neg = t.postings.find((p) => p.amount_paise < 0);
      return s + (neg ? -neg.amount_paise : 0);
    }, 0);

  const parentCards = parentCardsOf(active);
  const cardDueNow = (card: Account) => cardDueNowOf(active, cycles, card);
  const cardUnbilled = (card: Account) => cardUnbilledOf(active, cycles, card);
  const totalDue = parentCards.reduce((s, c) => s + cardDueNow(c), 0);
  const totalCardOwed = parentCards.reduce(
    (s, c) => s + cardDueNow(c) + cardUnbilled(c),
    0
  );
  // actuals + remaining commitments — a past month has nothing "to come"
  // to-pay counts only bills payable THIS month — unbilled swipes land on
  // next month's statement and belong to the Plan
  const bookA = monthActuals(accounts, txns, isPastMonth ? [] : monthTemplates, totalDue);
  const liquidNow = liquidNowOf(active, balances);
  const outlook = liquidOutlook(bookA, liquidNow);
  const savingsLabel = isPastMonth ? "savings" : "projected savings";

  // itemized breakdowns behind each headline number — same rules as monthActuals
  const postedTplIds = new Set(txns.map((x) => x.recurring_template_id).filter(Boolean));
  const tplUnposted = (isPastMonth ? [] : monthTemplates).filter((t) => !postedTplIds.has(t.id));
  const pendingByKind = (k: string) =>
    txns.filter(
      (x) =>
        x.status === "pending" &&
        !x.postings.some((pp) => accountById(accounts, pp.account_id)?.kind === "equity") &&
        oneOffKind(accounts, x) === k
    );
  const detailRows: Record<string, { title: string; rows: { label: string; paise: number }[] }> = {
    liquid: {
      title: "Liquid — spendable right now",
      rows: active
        .filter((a) => a.is_liquid)
        .map((a) => ({ label: a.name, paise: balances.get(a.id)?.balance_paise ?? 0 }))
        .filter((r) => r.paise !== 0),
    },
    toPay: {
      title: "To pay — going out before month end",
      rows: [
        ...parentCards
          .map((c) => ({ label: `${c.name} — bill due${c.due_day ? ` by the ${ordinal(c.due_day)}` : ""}`, paise: -cardDueNow(c) }))
          .filter((r) => r.paise !== 0),
        ...tplUnposted
          .filter((t) =>
            !isIncomeTemplate(accounts, t) && !isInternalTemplate(accounts, t) &&
            accountById(accounts, t.from_account_id)?.subtype !== "credit_card")
          .map((t) => ({ label: `${t.name} — recurring, ${ordinal(t.day_of_month)}`, paise: -t.amount_paise })),
        ...pendingByKind("out").map((x) => ({ label: `${x.description} — planned, ${fmtDate(x.date)}`, paise: -oneOffAmount(x) })),
      ],
    },
    toReceive: {
      title: "To receive — coming in before month end",
      rows: [
        ...tplUnposted
          .filter((t) => isIncomeTemplate(accounts, t))
          .map((t) => ({ label: `${t.name} — ${ordinal(t.day_of_month)}`, paise: t.amount_paise })),
        ...pendingByKind("in").map((x) => ({ label: `${x.description} — planned, ${fmtDate(x.date)}`, paise: oneOffAmount(x) })),
        ...(isPastMonth ? [] : monthTemplates)
          .filter((t) => t.reimburse_account_id && t.reimburse_amount_paise &&
            (personCredits.get(t.reimburse_account_id) ?? 0) < t.reimburse_amount_paise)
          .map((t) => ({
            label: `${accountById(accounts, t.reimburse_account_id)?.name} repays ${t.name}`,
            paise: t.reimburse_amount_paise ?? 0,
          })),
        ...(isPastMonth ? [] : txns)
          .filter((x) => x.reimburse_account_id && x.reimburse_amount_paise &&
            !(x.recurring_template_id &&
              monthTemplates.some((t) => t.id === x.recurring_template_id && t.reimburse_account_id)) &&
            (personCredits.get(x.reimburse_account_id) ?? 0) < x.reimburse_amount_paise)
          .map((x) => ({
            label: `${accountById(accounts, x.reimburse_account_id)?.name} repays ${x.description}`,
            paise: x.reimburse_amount_paise ?? 0,
          })),
        ...pendingByKind("back").map((x) => ({ label: `${x.description} — ${fmtDate(x.date)}`, paise: oneOffAmount(x) })),
      ],
    },
  };

  // ---- actions
  async function postVirtual(t: RecurringTemplate, amountStr: string) {
    const paise = parseRupees(amountStr);
    if (!paise || paise <= 0) return;
    const scale = paise / t.amount_paise;
    try {
      await createEntry(store, {
        ledgerId: ledgerId!,
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
      await createEntry(store, {
        ledgerId: ledgerId!,
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

  async function addPerson(name: string) {
    if (!name.trim()) return;
    const { error: e } = await store
      .createAccount({
        ledger_id: ledgerId!,
        name: name.trim(),
        kind: "asset",
        subtype: "receivable",
        person_name: name.trim(),
        parent_id: null,
        statement_day: null,
        due_day: null,
        credit_limit_paise: null,
        reported_balance_paise: null,
        reported_at: null,
        sort_order: 0,
        archived: false,
        is_liquid: false,
      })
      .then(() => ({ error: null as { message: string } | null }))
      .catch((err: Error) => ({ error: { message: err.message } }));
    if (e) setError(e.message);
    else await reload();
  }

  async function patchTxn(txn: Transaction, patch: Partial<Transaction>) {
    // the whole row goes down, not just the change: an encrypted payload is
    // re-sealed from every field, so a bare patch would lose the rest
    await store.patchTransaction(txn, patch);
    await refreshAll();
  }

  async function saveEdit(row: TxnRow, patch: Partial<EntryInput>) {
    if (!row.fromId || !row.toId) return;
    try {
      await rewriteEntry(store, row.txn.id, {
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
    await store.deleteTransaction(row.txn.id);
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

  if (loading) return <PageSkeleton />;

  const monthName = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const cellCls = "px-2 py-1.5";

  return (
    <div className="space-y-5 xl:h-[calc(100vh-6.5rem)] xl:flex xl:flex-col xl:overflow-hidden">
      {/* header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => shiftMonth(-1)} disabled={!canPrev}
            className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft disabled:opacity-30 disabled:hover:bg-transparent">←</button>
          <h1 className="text-3xl w-[250px] text-center whitespace-nowrap">{monthName}</h1>
          <button onClick={() => shiftMonth(1)} disabled={!canNext}
            className="border border-rule px-2 py-1 text-sm hover:bg-ledger-soft disabled:opacity-30 disabled:hover:bg-transparent">→</button>
        </div>
      </div>

      {error && <p className="text-sm text-debit border border-debit-soft bg-debit-soft px-3 py-2">{error}</p>}

      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 border border-rule bg-paper-raised px-2 py-1">
            <Search size={13} className="text-ink-faint shrink-0" />
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search entries…"
              className="text-sm bg-transparent w-44" />
            {query && (
              <button onClick={() => setQuery("")} aria-label="Clear search" title="Clear search"
                className="text-ink-faint hover:text-ink"><X size={12} /></button>
            )}
          </div>
          <Select chrome value={fAcct} onChange={setFAcct} placeholder="Any account" className="w-44"
            groups={[{ options: [{ value: "", label: "Any account" }] }, ...accountGroups(active)]} />
          <Select chrome value={fTag} onChange={setFTag} placeholder="Any tag" className="w-32"
            groups={[{ options: [{ value: "", label: "Any tag" },
              ...knownTags.map((t) => ({ value: t, label: t }))] }]} />
          <Select chrome value={fStatus} onChange={setFStatus} placeholder="Any status" className="w-32"
            groups={[{ options: [
              { value: "", label: "Any status" },
              { value: "done", label: "Done" },
              { value: "pending", label: "Planned" },
              { value: "projected", label: "Projected" },
            ] }]} />
          {filtering && (
            <button onClick={() => { setQuery(""); setFAcct(""); setFTag(""); setFStatus(""); }}
              className="flex items-center gap-1 text-xs text-ink-soft hover:text-debit">
              <X size={12} /> {monthRows.length} of {totalRows} — clear
            </button>
          )}
        </div>
        <div className="flex gap-6 text-sm flex-wrap">
          <button onClick={() => setDetailFor("liquid")} className="text-right" title="Which accounts make this up?">
            <Headline label="liquid" paise={outlook.liquidNow} />
          </button>
          <button onClick={() => setDetailFor("toPay")} className="text-right" title="What is still going out?">
            <Headline label="to pay" paise={-outlook.toPay} cls={outlook.toPay > 0 ? "text-debit" : ""} />
          </button>
          <button onClick={() => setDetailFor("toReceive")} className="text-right" title="What is still coming in?">
            <Headline label="to receive" paise={outlook.toReceive} cls="text-ledger" incoming={outlook.toReceive > 0} />
          </button>
          <button onClick={() => setLeftOpen(true)} title="How is this calculated?" className="text-right">
            <Headline label={`${savingsLabel} ⓘ`} paise={outlook.projected}
              cls={outlook.projected >= 0 ? "text-ledger" : "text-debit"} />
          </button>
        </div>
      </div>

      <div className="grid xl:grid-cols-[1fr_310px] gap-5 items-start xl:items-stretch xl:flex-1 xl:min-h-0 xl:grid-rows-[minmax(0,1fr)]">
        {/* ledger column */}
        <div className="min-w-0 xl:h-full xl:flex xl:flex-col">
        <div className="no-scrollbar border border-rule bg-paper-raised overflow-x-auto xl:flex-1 xl:min-h-0 xl:overflow-y-auto">
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
              <QuickAddRow accounts={active} supabase={supabase} store={store} ledgerId={ledgerId} ledgerKey={ledgerKey} onDone={refreshAll}
                onAdded={(id) => setJustAdded((l) => [...l, id])} onError={setError} />
              {orderedRows.map((row) => {
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
                    <tr key={"r" + row.id}
                      className={row.received ? "" : overdue ? "bg-debit-soft/40" : "bg-paper"}>
                      <td className={`${cellCls} amount text-ink-faint whitespace-nowrap`}>{fmtDate(row.date)}</td>
                      <td className={cellCls}>
                        <span className={row.received ? "" : overdue ? "text-debit" : "text-ink-soft"}>
                          {person?.name} repays {row.name}
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
                            label: `${accountById(accounts, row.personId)?.name} repays ${row.name}`,
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
                    justAdded={!filtering && justAdded.includes(row.txn.id)}
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
              {!filtering && openingRows.length > 0 && (
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
              {!filtering && openingOpen && openingRows.map((row) => (
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
            </tbody>
          </table>
          {monthRows.length === 0 && (filtering || openingRows.length === 0) && (
            <p className="text-sm text-ink-faint p-4">
              {filtering
                ? "Nothing matches the current filters."
                : isPastMonth
                  ? "Nothing was logged this month — past months show only real entries, nothing projected."
                  : "Empty month — add an entry above."}
            </p>
          )}
        </div>
        </div>

        {/* sidebar scrolls independently */}
        <aside className="no-scrollbar space-y-4 xl:h-full xl:overflow-y-auto">
          <SideBlock title="Accounts"
            total={<span className="amount text-xs">{formatPaise(
              active.filter((a) => ["bank", "cash"].includes(a.subtype))
                .reduce((sum, a) => sum + subtreeBalance(accounts, balances, a.id), 0)
            )}</span>}
            action={<span className="flex items-center gap-1">
              <IconBtn title="Manage categories & income" onClick={() => setCatOpen(true)}>
                <Settings2 size={13} />
              </IconBtn>
              <IconBtn title="Add bank / envelope / cash" onClick={() => setCreateAcct(BLOCK_OPTIONS.accounts)}>
                <Plus size={13} />
              </IconBtn>
            </span>}>
            {active.filter((a) => ["bank", "cash"].includes(a.subtype)).map((b) => {
              const total = subtreeBalance(accounts, balances, b.id);
              const own = balances.get(b.id)?.balance_paise ?? 0;
              const envs = active.filter((e) => e.parent_id === b.id);
              const recAt = b.reported_at
                ? new Date(b.reported_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
                : null;
              return (
                <div key={b.id}>
                  <div className="px-3 py-1.5 flex items-center justify-between gap-2">
                    <div>
                      <span className="flex items-center gap-1">
                        {envs.length > 0 && (
                          <button onClick={() => toggleTile(b.id)} aria-label={`Toggle ${b.name} breakdown`}
                            title={`Show/hide ${b.name} breakdown`}
                            className="text-ink-faint hover:text-ledger -ml-1">
                            {openTiles.has(b.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </button>
                        )}
                        <button onClick={() => openSheet(b.id)}
                          className="text-sm text-left hover:text-ledger" title={`${b.name} — details`}>
                          {b.name}
                        </button>
                      </span>
                      {recAt && (
                        <p className="text-[11px] text-ink-faint">✓ reconciled {recAt}</p>
                      )}
                    </div>
                    <AmountCell paise={total} />
                  </div>
                  {openTiles.has(b.id) && envs.length > 0 && (
                    <div className="pl-6 pr-3 py-1 flex items-baseline justify-between gap-2">
                      <span className="text-xs text-ink-soft">↳ Free</span>
                      <Amount paise={own} className="text-xs" />
                    </div>
                  )}
                  {openTiles.has(b.id) && envs.map((env) => (
                    <div key={env.id} className="pl-6 pr-3 py-1 flex items-baseline justify-between gap-2">
                      <button onClick={() => openSheet(env.id)}
                        className="text-xs text-ink-soft text-left hover:text-ledger" title={`${env.name} — details`}>
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
            total={<span className={`amount text-xs ${totalCardOwed > 0 ? "text-debit" : ""}`}>{formatPaise(-totalCardOwed)}</span>}
            action={<IconBtn title="Add card / sub-card" onClick={() => setCreateAcct(BLOCK_OPTIONS.cards)}>
              <Plus size={13} />
            </IconBtn>}>
            {parentCards.map((c) => {
              const due = cardDueNow(c);
              const unbilled = cardUnbilled(c);
              const owed = due + unbilled;
              const subs = active.filter((s) => s.parent_id === c.id);
              const recAt = c.reported_at
                ? new Date(c.reported_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
                : null;
              return (
                <div key={c.id} className="px-3 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1">
                      {subs.length > 0 && (
                        <button onClick={() => toggleTile(c.id)} aria-label={`Toggle ${c.name} breakdown`}
                          title={`Show/hide ${c.name} breakdown`}
                          className="text-ink-faint hover:text-ledger -ml-1">
                          {openTiles.has(c.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      )}
                      <button onClick={() => openSheet(c.id)}
                        className="text-sm text-left hover:text-ledger" title={`${c.name} — details`}>
                        {c.name}
                      </button>
                    </span>
                    <AmountCell paise={-owed}
                      cls={owed > 0 ? "text-debit" : "text-ink-faint"} />
                  </div>
                  {(due > 0 || unbilled > 0) && (
                    <p className="pl-3 py-0.5 text-[11px] text-ink-faint">
                      {due > 0 && <>pay <span className="amount amount-inline text-debit">{formatPaise(due)}</span> by the {ordinal(c.due_day)}</>}
                      {due > 0 && unbilled > 0 && " · "}
                      {unbilled > 0 && <><span className="amount amount-inline">{formatPaise(unbilled)}</span> bills the {ordinal(c.statement_day)}</>}
                    </p>
                  )}
                  {recAt && (
                    <p className="text-[11px] text-ink-faint">✓ reconciled {recAt}</p>
                  )}
                  {openTiles.has(c.id) && subs.length > 0 && (() => {
                    const subOwed = (id: string) =>
                      (cycles.get(id)?.spends_since_paise ?? 0) +
                      (cycles.get(id)?.billed_paise ?? 0) +
                      (cycles.get(id)?.payments_since_paise ?? 0);
                    const own = -owed - subs.reduce((sum, sc) => sum + subOwed(sc.id), 0);
                    return (
                      <>
                        <div className="pl-3 py-0.5 flex items-baseline justify-between gap-2">
                          <span className="text-xs text-ink-soft">↳ {c.name} itself</span>
                          <Amount paise={own} className="text-xs text-ink-faint" />
                        </div>
                        {subs.map((sc) => (
                          <div key={sc.id} className="pl-3 py-0.5 flex items-baseline justify-between gap-2">
                            <button onClick={() => openSheet(sc.id)}
                              className="text-xs text-ink-soft text-left hover:text-ledger" title={`${sc.name} — details`}>
                              ↳ {sc.name}
                            </button>
                            <Amount paise={subOwed(sc.id)} className="text-xs text-ink-faint" />
                          </div>
                        ))}
                      </>
                    );
                  })()}
                </div>
              );
            })}
          </SideBlock>

          <SideBlock title="Spending"
            total={<span className={`amount text-xs ${totalSpend > 0 ? "text-debit" : ""}`}>{formatPaise(-totalSpend)}</span>}>
            {catSpends.map(([id, paise]) => {
              const cat = accountById(accounts, id);
              if (!cat) return null;
              return (
                <div key={id} className="px-3 py-1.5 flex items-center justify-between gap-2">
                  <button onClick={() => openSheet(id)}
                    className="text-sm text-left hover:text-ledger truncate" title={`${cat.name} — details`}>
                    {cat.name}
                  </button>
                  <AmountCell paise={-paise} cls={paise > 0 ? "text-debit" : ""} />
                </div>
              );
            })}
            {catSpends.length === 0 && (
              <p className="px-3 py-1.5 text-xs text-ink-faint">Nothing spent this month yet.</p>
            )}
          </SideBlock>

          <SideBlock title="People"
            total={(() => {
              const net = active.filter((a) => a.subtype === "receivable")
                .reduce((sum, a) => sum + (balances.get(a.id)?.balance_paise ?? 0), 0);
              return <span className={`inline-flex items-center gap-0.5 amount text-xs ${net > 0 ? "text-ledger" : net < 0 ? "text-debit" : ""}`}>
                {net > 0 && <ArrowDownLeft size={10} className="text-ledger" />}
                {formatPaise(net)}
              </span>;
            })()}
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
                        <button onClick={() => openSheet(p.id)}
                          className="text-sm text-left hover:text-ledger truncate" title={`${p.name} — full ledger`}>
                          {p.name}
                        </button>
                        <AmountCell paise={bal}
                          cls={bal > 0 ? "text-ledger" : "text-debit"}
                          incoming={bal > 0} />
                      </div>
                      {p.reported_at && (
                        <p className="text-[11px] text-ink-faint">
                          ✓ agreed {new Date(p.reported_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                        </p>
                      )}
                    </div>
                  ))}
                  {settled.length > 0 && (
                    <p className="px-3 py-1.5 text-[11px] text-ink-faint">
                      settled:{" "}
                      {settled.map(({ p }, i) => (
                        <span key={p.id}>
                          {i > 0 && ", "}
                          <button onClick={() => openSheet(p.id)}
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
            total={<span className="amount text-xs">{formatPaise(
              active.filter((a) => a.subtype === "investment")
                .reduce((sum, a) => sum + (balances.get(a.id)?.balance_paise ?? 0), 0)
            )}</span>}
            action={<IconBtn title="Add investment" onClick={() => setCreateAcct(BLOCK_OPTIONS.investments)}>
              <Plus size={13} />
            </IconBtn>}>
            {active.filter((a) => a.subtype === "investment").map((v) => (
              <div key={v.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
                <button onClick={() => openSheet(v.id)}
                  className="text-sm text-left hover:text-ledger" title={`${v.name} — details`}>
                  {v.name}
                </button>
                <AmountCell paise={balances.get(v.id)?.balance_paise ?? 0} />
              </div>
            ))}
          </SideBlock>

          <SideBlock title="Loans"
            total={(() => {
              const rem = active.filter((a) => a.subtype === "loan")
                .reduce((sum, a) => sum + Math.max(0, -(balances.get(a.id)?.balance_paise ?? 0)), 0);
              return <span className={`amount text-xs ${rem > 0 ? "text-debit" : ""}`}>{formatPaise(-rem)}</span>;
            })()}
            action={<IconBtn title="Add loan" onClick={() => setCreateAcct(BLOCK_OPTIONS.loans)}>
              <Plus size={13} />
            </IconBtn>}>
            {active.filter((a) => a.subtype === "loan").map((l) => {
              const bal = balances.get(l.id)?.balance_paise ?? 0;
              const remaining = -bal; // liability: negative ledger balance = owed
              const tpl = templates.find((t) => t.to_account_id === l.id);
              const e = tpl ? emiInfo(tpl, month) : null;
              return (
                <div key={l.id} className="px-3 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <button onClick={() => openSheet(l.id)}
                      className="text-sm text-left hover:text-ledger" title={`${l.name} — details`}>
                      {l.name}
                    </button>
                    {remaining > 0 ? (
                      <AmountCell paise={-remaining} cls="text-debit" />
                    ) : (
                      <AmountCell paise={bal} cls="text-ink-faint" />
                    )}
                  </div>
                  <p className="text-[11px] text-ink-faint">
                    {remaining > 0
                      ? e && <>EMI {Math.min(Math.max(e.idx, 0), e.total)}/{e.total} · ends {fmtMonth(e.endISO)}</>
                      : bal !== 0
                        ? <button onClick={() => openSheet(l.id)} className="text-debit hover:underline">
                            set outstanding to track what's left
                          </button>
                        : "nothing tracked yet"}
                  </p>
                </div>
              );
            })}
          </SideBlock>
        </aside>
      </div>

      {detailFor && (
        <Modal open title={detailRows[detailFor].title} onClose={() => setDetailFor(null)}>
          <div className="text-sm space-y-1.5">
            {detailRows[detailFor].rows.map((r, i) => (
              <div key={i} className="flex items-baseline justify-between gap-4">
                <p className="text-ink-soft">{r.label}</p>
                <Amount paise={r.paise} signed={detailFor !== "liquid"} className="whitespace-nowrap" />
              </div>
            ))}
            {detailRows[detailFor].rows.length === 0 && (
              <p className="text-ink-faint text-sm">Nothing here right now.</p>
            )}
            <div className="border-t border-rule-strong pt-2 flex items-baseline justify-between gap-4 font-medium">
              <p>Total</p>
              <Amount signed={detailFor !== "liquid"}
                paise={detailRows[detailFor].rows.reduce((sum, r) => sum + r.paise, 0)} />
            </div>
          </div>
        </Modal>
      )}

      <Modal open={leftOpen} title={`How ${savingsLabel} is calculated`}
        subtitle="Liquid today − what must still go out + what is still to come in" onClose={() => setLeftOpen(false)}>
        <div className="text-sm space-y-2">
          <CalcLine label="Liquid now — spendable accounts" paise={outlook.liquidNow} sign="" bold />
          <CalcLine label="Card bills due this month" paise={bookA.cardToPay} sign="−" />
          {bookA.stillToGo > 0 && (
            <CalcLine label="Commitments to go — unposted recurring + planned spends" paise={bookA.stillToGo} sign="−" />
          )}
          {bookA.incomeToCome > 0 && (
            <CalcLine label="Income to come" paise={bookA.incomeToCome} sign="+" />
          )}
          {bookA.comingBack > 0 && (
            <CalcLine label="Repayments expected" paise={bookA.comingBack} sign="+" />
          )}
          <div className="border-t border-rule-strong pt-2">
            <CalcLine label="Projected liquid at month end" paise={outlook.projected} sign="=" bold />
          </div>
          <p className="text-xs text-ink-faint pt-1">
            Everything already received or spent is inside today&apos;s liquid
            balance — nothing is counted twice. Unbilled card swipes
            ({formatPaise(totalCardOwed - totalDue)}) bill next month and live
            in the Plan. This month so far:
            received {formatPaise(bookA.received + bookA.receivedBack)},
            spent {formatPaise(bookA.spent)}
            {avoidable > 0 && <>, of which {formatPaise(avoidable)} was tagged avoidable</>}.
          </p>
        </div>
      </Modal>

      <ReconcileModal
        account={reconFor}
        onDone={refreshAll}
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
        subtitle="Record money received"
        onClose={() => setReceiveModal(null)}
      >
        <Field label="Amount received (₹)">
          <input
            value={receiveAmt}
            onChange={(e) => setReceiveAmt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && recordReceive()}
            inputMode="decimal"
            placeholder="0"
            className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount"
            autoFocus
          />
        </Field>
        <Field label="Into account" className="mt-2">
          <Select chrome value={receiveBank} onChange={setReceiveBank} placeholder="Choose…"
            groups={[{ options: banks.map((b) => ({ value: b.id, label: b.name })) }]} />
        </Field>
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

      {createAcct && (
        <AccountModal
          open
          optionIdxs={createAcct}
          onDone={refreshAll}
          onClose={() => setCreateAcct(null)}
        />
      )}

      <CategoriesModal
        open={catOpen}
        accounts={accounts}
        balances={balances}
        onEdit={(a) => {
          setCatOpen(false);
          openSheet(a.id);
        }}
        onNew={() => setCreateAcct([8, 9])}
        onClose={() => setCatOpen(false)}
      />

      <AccountSheet
        accountId={sheetId}
        onDone={refreshAll}
        onReconcile={(a) => setReconFor(a)}
        onOpenAccount={openSheet}
        onAddChild={(idxs) => setCreateAcct(idxs)}
        onClose={closeSheet}
      />

      {/* display:none, kept last so space-y rhythm matches the Plan page */}
      <datalist id="known-tags">
        {knownTags.map((t) => <option key={t} value={t} />)}
      </datalist>

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
            await createEntry(store, {
              ledgerId: ledgerId!,
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
    <Modal open title={`Cover "${row.txn.description}"`}
      subtitle={`Refill ${target?.name} from the account that was meant to pay`} onClose={onClose}>
      <p className="text-xs text-ink-soft mb-3">
        {target?.name} paid this as a stand-in — record the transfer that
        refills it from the account that was really meant to pay.
      </p>
      <Field label="Pull funds from">
        <Select chrome value={sourceId} onChange={setSourceId} placeholder="Choose…"
          groups={[{ options: sources.map((a) => ({ value: a.id, label: `${a.name} → ${target?.name}` })) }]} />
      </Field>
      <Field label="Amount (₹)" className="mt-2">
        <input value={amt} onChange={(e) => setAmt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sourceId && paise && paise > 0 && onSave(sourceId, paise)}
          inputMode="decimal" placeholder="0"
          className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount" />
      </Field>
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
    <Modal open title={`Split "${row.txn.description}"`}
      subtitle="Someone owes part of this expense" onClose={onClose}>
      <p className="text-xs text-ink-soft mb-3">
        Their share is added to what they owe you; your expense shrinks by the same amount.
      </p>
      <Field label="Who owes part?">
        <Select chrome value={personId} onChange={setPersonId} placeholder="No split"
          groups={[{ options: [{ value: "", label: "No split" },
            ...people.map((p) => ({ value: p.id, label: p.name }))] }]} />
      </Field>
      {personId && (
        <Field label="Their share (₹)" className="mt-2"
          hint={`Must be less than the full ${formatPaise(row.amountPaise)}`}>
          <input value={amt} onChange={(e) => setAmt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSave(personId, paise)}
            inputMode="decimal" placeholder="0"
            className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount" />
        </Field>
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

/**
 * Right-hand cell every sidebar tile shares. Sign convention carries the
 * meaning: owe = negative red, have = positive ink, incoming = green + arrow.
 */
function AmountCell({
  paise, cls = "", incoming = false, action,
}: {
  paise: number;
  cls?: string;
  incoming?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {action}
      <span className="inline-flex items-center gap-0.5">
        {incoming && <ArrowDownLeft size={11} className="text-ledger" />}
        <Amount paise={paise} className={cls} />
      </span>
    </div>
  );
}

function TxnEditRow({
  row, accounts, active, today, justAdded = false, expanded, onToggleExpand, onSplit, onCover, onSave, onPatch, onDelete,
}: {
  row: TxnRow;
  accounts: Account[];
  active: Account[];
  today: string;
  justAdded?: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSplit: () => void;
  onCover: () => void;
  onSave: (row: TxnRow, patch: Partial<EntryInput>) => void;
  onPatch: (txn: Transaction, patch: Partial<Transaction>) => void;
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
            <button onClick={onDelete} title="Delete entry" aria-label="Delete entry"
              className="text-ink-faint hover:text-debit">×</button>
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
    <tr className={`${justAdded ? "just-added" : ""} ${pending ? "bg-pending-soft/40" : justAdded ? "bg-ledger-soft/40" : ""}`}>
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
            if (v !== (t.tag ?? "")) onPatch(t, { tag: v || null });
          }}
          className={`text-xs ${t.tag ? "text-pending" : "text-ink-faint"}`} />
      </td>
      <td>
        <input defaultValue={t.notes ?? ""} placeholder="—"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (t.notes ?? "")) onPatch(t, { notes: v || null });
          }}
          className="text-xs text-ink-soft" />
      </td>
      <td className="px-2 py-1.5 text-right whitespace-nowrap">
        {t.recurring_template_id && (
          <span className="text-xs text-ledger mr-1" title="Posted from a recurring item">✓</span>
        )}
        {pending ? (
          <button onClick={() => onPatch(t, { status: "done", date: today })}
            className="text-xs text-ledger hover:underline mr-1">paid</button>
        ) : (
          <IconBtn title="Mark pending again" onClick={() => onPatch(t, { status: "pending" })}>
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
        <button onClick={onDelete} title="Delete entry" aria-label="Delete entry"
          className="text-ink-faint hover:text-debit ml-1">×</button>
      </td>
    </tr>
  );
}

function QuickAddRow({
  accounts, supabase, store, ledgerId, ledgerKey, onDone, onAdded, onError,
}: {
  accounts: Account[];
  supabase: ReturnType<typeof useLedger>["supabase"];
  store: ReturnType<typeof useLedger>["store"];
  ledgerId: string | null;
  ledgerKey: Uint8Array | null;
  onDone: () => Promise<unknown>;
  onAdded: (txnId: string) => void;
  onError: (m: string | null) => void;
}) {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [tag, setTag] = useState("");
  const [note, setNote] = useState("");
  // which "＋ New …" row was picked, if any — the same modal creates both
  const [creating, setCreating] = useState<"expense" | "income" | null>(null);
  const [planned, setPlanned] = useState<boolean | null>(null); // null = follow the date
  const suggestions = useTitleSuggestions(supabase, ledgerId, ledgerKey);

  const isPlanned = planned ?? date > toISODate(new Date());

  const fromChoices = accounts.filter((a) =>
    ["bank", "envelope", "cash", "investment", "credit_card", "receivable", "salary", "other_income"].includes(a.subtype)
  );
  const toChoices = accounts.filter((a) =>
    !["salary", "other_income", "opening_balance"].includes(a.subtype)
  );
  const defaultCat = accounts.find((a) => a.kind === "expense"); // first category = default destination

  async function createCategory(name: string) {
    if (!name.trim() || !creating) return;
    const income = creating === "income";
    try {
      const acc = await store.createAccount({
        ledger_id: ledgerId!,
        name: name.trim(),
        kind: income ? "income" : "expense",
        subtype: income ? "other_income" : "general_expense",
        parent_id: null,
        statement_day: null,
        due_day: null,
        credit_limit_paise: null,
        person_name: null,
        reported_balance_paise: null,
        reported_at: null,
        sort_order: 0,
        archived: false,
        is_liquid: false,
      });
      await onDone();
      if (income) setFromId(acc.id);
      else setToId(acc.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed");
    }
  }

  async function submit() {
    const paise = parseRupees(amount);
    if (!desc.trim() || !fromId || !paise || paise <= 0) return;
    try {
      const txnId = await createEntry(store, {
        ledgerId: ledgerId!,
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
      onAdded(txnId);
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
      <tr className="quick-add bg-ledger-soft/50" onKeyDown={(e) => e.key === "Enter" && submit()}>
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
            <AccountSelect value={fromId} choices={fromChoices} allowCreate="income"
              onChange={(v) => (v === NEW_INCOME ? setCreating("income") : setFromId(v))}
              placeholder="from…" className="w-1/2" />
            <span className="text-ink-faint text-xs">→</span>
            <AccountSelect value={toId} choices={toChoices} allowCreate="expense"
              placeholder={defaultCat?.name ?? "category…"}
              onChange={(v) => (v === NEW_CATEGORY ? setCreating("expense") : setToId(v))}
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
        open={creating !== null}
        title={creating === "income" ? "New income source" : "New category"}
        label={creating === "income"
          ? "Where the money comes from (e.g. Salary, Freelance, Interest)"
          : "Category name (e.g. Swiggy, Transport, Groceries)"}
        placeholder={creating === "income" ? "Income source" : "Category"}
        submitLabel="Create"
        onSubmit={createCategory}
        onClose={() => setCreating(null)}
      />
    </>
  );
}

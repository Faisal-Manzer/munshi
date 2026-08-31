"use client";

/**
 * Bringing a file into the book.
 *
 * Three steps, and the middle one is the point: read the file, say what each
 * column means, then look at exactly what will be written before any of it is.
 * A wrong column mapping is the failure mode here — a date column read as
 * mm/dd puts a year of spending on the wrong days, and there is no undo — so
 * nothing is written until the preview has been approved.
 *
 * The write itself is one `applyAll`, the same batch path an MCP proposal
 * takes: an import approved as 200 entries must not land as 140.
 */
import { useMemo, useRef, useState } from "react";
import { useLedger } from "@/lib/use-ledger";
import { loadLedger } from "@munshi/store";
import {
  cellText, describePlan, formatPaise, guessColumns, looksLikeHeader, planRestore,
  planSheet, planToOps, readArchive, validateBatch,
  type CellValue, type ImportPlan, type LedgerOp, type SheetColumn, type SheetMapping,
} from "@munshi/core";
import { IMPORT_ACCEPT, readImportFile, type ReadFile } from "@/lib/import/read-file";
import { Modal } from "@/components/modal";
import { Field } from "@/components/field";
import { Select } from "@/components/select";
import { AccountSelect } from "@/components/account-select";
import { AlertTriangle, CheckCircle2, Upload } from "lucide-react";

const COLUMN_LABEL: Record<SheetColumn, string> = {
  ignore: "— ignore —",
  date: "Date",
  description: "Title / narration",
  from: "From account",
  to: "To account / category",
  amount: "Amount (signed)",
  debit: "Debit (money out)",
  credit: "Credit (money in)",
  status: "Status",
  tag: "Tag",
  notes: "Notes",
};

const COLUMN_GROUPS = [
  { options: [{ value: "ignore", label: COLUMN_LABEL.ignore }] },
  {
    label: "Required",
    options: (["date", "description", "amount", "debit", "credit"] as SheetColumn[])
      .map((c) => ({ value: c, label: COLUMN_LABEL[c] })),
  },
  {
    label: "Optional",
    options: (["from", "to", "status", "tag", "notes"] as SheetColumn[])
      .map((c) => ({ value: c, label: COLUMN_LABEL[c] })),
  },
];

export function ImportModal({ onClose }: { onClose: () => void }) {
  const { store, ledgerId, ledgerKey, keyReady, supabase, accounts } = useLedger();
  const [file, setFile] = useState<ReadFile | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [columns, setColumns] = useState<SheetColumn[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [dayFirst, setDayFirst] = useState(true);
  const [accountId, setAccountId] = useState("");
  const [spendToId, setSpendToId] = useState("");
  const [receiveFromId, setReceiveFromId] = useState("");
  const [createMissing, setCreateMissing] = useState(true);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const rows: CellValue[][] = file?.sheets[sheetIdx]?.rows ?? file?.rows ?? [];

  // ids are minted here, not in the planner: core stays pure and a plan can be
  // rebuilt on every keystroke without the ids drifting under the preview
  const newId = () => crypto.randomUUID();

  /**
   * Open a sheet on its best guess: whether row one is a header, and what each
   * column looks like. Only ever a starting point — the mapping below is the
   * thing that decides, and it is right there to be corrected.
   */
  function openSheet(sheet: CellValue[][]) {
    const first = sheet[0] ?? [];
    const header = looksLikeHeader(first);
    setHasHeader(header);
    setColumns(header ? guessColumns(first) : first.map(() => "ignore" as SheetColumn));
  }

  async function pick(f: File) {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const read = await readImportFile(f);
      setFile(read);
      if (read.kind === "sheet") {
        // the cover page is never the data — open on the widest sheet
        const widest = read.sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
        setSheetIdx(read.sheets.indexOf(widest));
        openSheet(widest.rows);
      }
    } catch (e) {
      setFile(null);
      setError(e instanceof Error ? e.message : "could not read that file");
    }
    setBusy(false);
  }

  const mapping: SheetMapping = {
    columns, hasHeader, dayFirst,
    accountId: accountId || null,
    spendToId: spendToId || null,
    receiveFromId: receiveFromId || null,
    createMissing,
    onDuplicate: skipDuplicates ? "skip" : "import",
  };

  const plan: ImportPlan | null = useMemo(() => {
    if (!file || !ledgerId) return null;
    const ctx = { ledgerId, accounts, transactions: [], postings: [], newId };
    try {
      if (file.kind === "json") {
        const read = readArchive(file.json);
        if ("error" in read) {
          return { entries: [], accounts: [], problems: [{ row: 0, message: read.error }], duplicates: 0, rowsRead: 0 };
        }
        return planRestore(read.bundle, ctx, { onDuplicate: skipDuplicates ? "skip" : "import" });
      }
      return planSheet(rows, mapping, ctx);
    } catch (e) {
      return {
        entries: [], accounts: [],
        problems: [{ row: 0, message: e instanceof Error ? e.message : "could not read that file" }],
        duplicates: 0, rowsRead: 0,
      };
    }
    // the plan is a pure function of these; `accounts` is the book as loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, sheetIdx, columns, hasHeader, dayFirst, accountId, spendToId, receiveFromId,
      createMissing, skipDuplicates, accounts, ledgerId]);

  /**
   * Duplicate detection runs against the book as it is *now*, not against the
   * slice this screen happens to hold, so the whole ledger is re-read at commit
   * time and the plan rebuilt against it. Cheap, and it means a tab left open
   * overnight cannot re-import yesterday's statement.
   */
  async function commit() {
    if (!plan || !ledgerId) return;
    setBusy(true);
    setError(null);
    try {
      if (!keyReady) throw new Error("Still opening the book — try again in a moment.");
      const snap = await loadLedger(supabase, ledgerId, ledgerKey, { withTemplates: false });
      const ctx = {
        ledgerId, accounts: snap.accounts,
        transactions: snap.transactions, postings: snap.postings, newId,
      };
      let fresh: ImportPlan;
      if (file?.kind === "json") {
        const read = readArchive(file.json);
        if ("error" in read) throw new Error(read.error);
        fresh = planRestore(read.bundle, ctx, { onDuplicate: skipDuplicates ? "skip" : "import" });
      } else {
        fresh = planSheet(rows, mapping, ctx);
      }
      if (fresh.entries.length === 0) throw new Error("Nothing left to import.");

      const ops: LedgerOp[] = planToOps(fresh, ledgerId);
      const problems = validateBatch(ops, snap.accounts.map((a) => a.id));
      if (problems.length > 0) {
        throw new Error(`This import does not add up: ${problems[0].message}`);
      }
      await store.applyAll(ops);
      setResult(
        `Imported ${fresh.entries.length} ${fresh.entries.length === 1 ? "entry" : "entries"}` +
        (fresh.accounts.length > 0 ? ` and ${fresh.accounts.length} new accounts` : "") + "."
      );
      setFile(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed");
    }
    setBusy(false);
  }

  const check = "flex items-center gap-2 text-sm text-ink-soft";

  return (
    <Modal open wide title="Import into this book"
      subtitle="A Munshi archive, a bank statement, or any spreadsheet — read in this tab"
      onClose={onClose}>
      <div className="space-y-4">
        {/* ---- step 1: the file */}
        <div>
          <input ref={inputRef} type="file" accept={IMPORT_ACCEPT} className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
          <button onClick={() => inputRef.current?.click()} disabled={busy}
            className="w-full flex items-center justify-center gap-2 border border-dashed border-rule-strong px-3 py-4 text-sm text-ink-soft hover:border-ledger hover:text-ledger disabled:opacity-60">
            <Upload size={15} />
            {file ? `${file.fileName} — choose another` : "Choose a .json, .csv or .xlsx file"}
          </button>
        </div>

        {result && (
          <div className="border border-ledger/40 bg-ledger-soft/40 p-3 space-y-2">
            <p className="text-sm text-ledger flex items-center gap-1.5">
              <CheckCircle2 size={14} /> {result}
            </p>
            {/* the Book holds its own copy of the month; reload rather than
                leave the screen showing a ledger the import already changed */}
            <button onClick={() => window.location.reload()}
              className="text-sm bg-ledger text-paper-raised px-3 py-1.5 hover:opacity-90">
              Show the book
            </button>
          </div>
        )}
        {error && <p className="text-sm text-debit">{error}</p>}

        {file?.kind === "json" && plan && (
          <p className="text-xs text-ink-faint">
            A Munshi archive. Accounts already in this book are matched by name
            and reused; the rest are recreated. Nothing is overwritten — a
            restore only ever adds.
          </p>
        )}

        {/* ---- step 2: what the columns mean */}
        {file?.kind === "sheet" && (
          <div className="space-y-3">
            {file.sheets.length > 1 && (
              <Field label="Sheet">
                <Select chrome value={String(sheetIdx)}
                  onChange={(v) => {
                    setSheetIdx(Number(v));
                    openSheet(file.sheets[Number(v)]?.rows ?? []);
                  }}
                  groups={[{ options: file.sheets.map((s, i) => ({
                    value: String(i), label: `${s.name} · ${s.rows.length} rows`,
                  })) }]} />
              </Field>
            )}

            <div>
              <p className="text-[10px] uppercase tracking-[0.15em] text-ink-faint mb-1.5">
                What each column means
              </p>
              <div className="space-y-1.5 max-h-56 overflow-y-auto no-scrollbar pr-1">
                {columns.map((c, i) => {
                  const head = hasHeader ? cellText(rows[0]?.[i]) : `Column ${i + 1}`;
                  const sample = cellText(rows[hasHeader ? 1 : 0]?.[i]);
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <div className="w-1/2 min-w-0">
                        <p className="text-sm truncate">{head || `Column ${i + 1}`}</p>
                        {sample && <p className="text-[11px] text-ink-faint truncate">e.g. {sample}</p>}
                      </div>
                      <div className="w-1/2">
                        <Select chrome value={c} groups={COLUMN_GROUPS}
                          onChange={(v) => setColumns((cs) =>
                            cs.map((old, j) => (j === i ? (v as SheetColumn) : old)))} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="This sheet belongs to"
                hint="The account every row touches — a bank or a card">
                <AccountSelect chrome value={accountId} onChange={setAccountId}
                  choices={active.filter((a) => a.kind === "asset" || a.kind === "liability")}
                  placeholder="Choose…" />
              </Field>
              <Field label="Unmatched spending goes to" hint="Recategorise later in the Book">
                <AccountSelect chrome value={spendToId} onChange={setSpendToId}
                  choices={active.filter((a) => a.kind === "expense")} placeholder="Choose…" />
              </Field>
              <Field label="Unmatched income comes from">
                <AccountSelect chrome value={receiveFromId} onChange={setReceiveFromId}
                  choices={active.filter((a) => a.kind === "income")} placeholder="Choose…" />
              </Field>
              <Field label="Dates read as"
                hint="No file can tell 03/04 apart — say which">
                <Select chrome value={dayFirst ? "dmy" : "mdy"}
                  onChange={(v) => setDayFirst(v === "dmy")}
                  groups={[{ options: [
                    { value: "dmy", label: "day / month / year" },
                    { value: "mdy", label: "month / day / year" },
                  ] }]} />
              </Field>
            </div>

            <label className={check}>
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              First row is a header
            </label>
            <label className={check}>
              <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
              Create accounts named in the file that don&rsquo;t exist yet
            </label>
          </div>
        )}

        {file && (
          <label className={check}>
            <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
            Skip rows already in the book (same date, amount and title)
          </label>
        )}

        {/* ---- step 3: exactly what lands */}
        {file && plan && <Preview plan={plan} names={nameLookup(active, plan)} />}

        {file && (
          <div className="flex items-center justify-between gap-3 border-t border-rule pt-3">
            <p className="text-xs text-ink-faint">{describePlan(plan ?? emptyPlan)}</p>
            <button onClick={commit} disabled={busy || !plan || plan.entries.length === 0}
              className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90 disabled:opacity-50">
              {busy ? "Importing…" : `Import ${plan?.entries.length ?? 0}`}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

const emptyPlan: ImportPlan = {
  entries: [], accounts: [], problems: [], duplicates: 0, rowsRead: 0,
};

/** Account names for the preview — the book's, plus the ones this import mints. */
function nameLookup(
  accounts: { id: string; name: string }[],
  plan: ImportPlan
): Map<string, string> {
  const map = new Map(accounts.map((a) => [a.id, a.name]));
  for (const a of plan.accounts) map.set(a.id, a.name);
  return map;
}

const PREVIEW_ROWS = 8;

function Preview({ plan, names }: { plan: ImportPlan; names: Map<string, string> }) {
  const shown = plan.entries.slice(0, PREVIEW_ROWS);
  const more = plan.entries.length - shown.length;

  return (
    <div className="space-y-2">
      {plan.accounts.length > 0 && (
        <p className="text-xs text-ink-soft">
          <span className="text-ledger">New accounts:</span>{" "}
          {plan.accounts.map((a) => a.name).join(", ")}
        </p>
      )}

      {shown.length > 0 && (
        <div className="border border-rule max-h-52 overflow-y-auto no-scrollbar">
          <table className="w-full text-xs">
            <tbody className="divide-y divide-rule/60">
              {shown.map((e) => (
                <tr key={e.row} className={e.duplicate ? "text-ink-faint" : ""}>
                  <td className="px-2 py-1 amount whitespace-nowrap">{e.date}</td>
                  <td className="px-2 py-1 max-w-[10rem] truncate">{e.description}</td>
                  <td className="px-2 py-1 text-ink-faint truncate">
                    {names.get(e.fromAccountId) ?? "?"} → {names.get(e.toAccountId) ?? "?"}
                  </td>
                  <td className="px-2 py-1 text-right amount whitespace-nowrap">
                    {formatPaise(e.amountPaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more > 0 && <p className="text-[11px] text-ink-faint">…and {more} more.</p>}

      {plan.problems.length > 0 && (
        <div className="border border-debit/40 bg-debit-soft/30 p-2 max-h-32 overflow-y-auto no-scrollbar">
          <p className="text-xs text-debit flex items-center gap-1.5 mb-1">
            <AlertTriangle size={12} />
            {plan.problems.length} {plan.problems.length === 1 ? "row" : "rows"} will not be imported
          </p>
          {plan.problems.slice(0, 20).map((p, i) => (
            <p key={i} className="text-[11px] text-ink-soft">
              {p.row > 0 ? `Row ${p.row}: ` : ""}{p.message}
            </p>
          ))}
          {plan.problems.length > 20 && (
            <p className="text-[11px] text-ink-faint">…and {plan.problems.length - 20} more.</p>
          )}
        </div>
      )}
    </div>
  );
}

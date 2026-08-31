/**
 * Getting a book in.
 *
 * The mirror of `export.ts`, and it has the same reason to exist: on an
 * encrypted ledger nothing server-side can read a file, so parsing, mapping
 * and preview all happen where the key is. Everything here is pure — text and
 * cells in, a plan and then `LedgerOp[]` out. No storage, no clock, and no
 * ids invented behind the caller's back (`newId` is passed in), which is what
 * lets the whole thing be previewed before a single row is written.
 *
 * Two doors:
 *
 * - **Restore** (`planRestore`) takes a Munshi JSON archive back. Ids are not
 *   reused — an archive may be restored into a book that already holds rows,
 *   so every account is either matched to one that exists or minted fresh,
 *   and postings are remapped onto the result.
 * - **Sheet** (`planSheet`) takes any CSV or spreadsheet: a bank statement, an
 *   old tracker, or our own `entries.csv`. The caller says which column means
 *   what; this decides what that produces.
 */
import { entryCreateOp } from "./entries";
import { accountCreateOp } from "./ops";
import type { LedgerOp, NewAccount } from "./store";
import type {
  Account,
  AccountKind,
  AccountSubtype,
  Posting,
  Transaction,
  TxnStatus,
} from "./types";

/** What a spreadsheet cell can arrive as. `read-excel-file` hands back real Dates and numbers. */
export type CellValue = string | number | boolean | Date | null | undefined;

// ---------------------------------------------------------------- delimited text

/** Guess the separator from the first line — Indian exports are as often `;` as `,`. */
export function sniffDelimiter(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t", "|"].map(
    (d) => [d, line.split(d).length - 1] as const
  );
  const best = counts.sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

/**
 * RFC 4180, plus the things real files do: CRLF or LF, a UTF-8 BOM, quoted
 * fields containing the delimiter or a newline, `""` for a literal quote.
 * Written as a scanner rather than a regex because a field may span lines,
 * and splitting on newlines first would already have lost.
 */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = delimiter ?? sniffDelimiter(body);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === d) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  // trailing newline leaves one empty row; so do the blank lines banks pad with
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ---------------------------------------------------------------- cells

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

/**
 * Excel keeps dates as days since 1899-12-30 (the 1900 leap-year bug baked in).
 * Only plausible serials convert — otherwise a bare amount column that got
 * mapped to `date` by mistake would silently become dates in 2043.
 */
function fromExcelSerial(n: number): string | null {
  if (!Number.isFinite(n) || n < 20000 || n > 60000) return null;
  const ms = Math.round(n) * 86_400_000 + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * @param dayFirst 03/04 is 3 April, not 4 March. Default for this app, since
 *   every Indian bank writes dd/mm — but a US-shaped export needs the flag off,
 *   and no heuristic can tell 03/04 apart, so the caller must say.
 */
export function parseImportDate(raw: CellValue, dayFirst = true): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return iso(raw.getFullYear(), raw.getMonth() + 1, raw.getDate());
  }
  if (typeof raw === "number") return fromExcelSerial(raw);

  const s = String(raw).trim();
  if (!s) return null;

  // yyyy-mm-dd / yyyy/mm/dd — unambiguous, so it wins regardless of dayFirst
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);

  // 04 Aug 2026 / 4-Aug-26 / Aug 4, 2026
  m = /^(\d{1,2})[\s\-/]*([A-Za-z]{3,})[\s\-/,]*(\d{2,4})$/.exec(s);
  if (m) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mon >= 0) return iso(fullYear(+m[3]), mon + 1, +m[1]);
  }
  m = /^([A-Za-z]{3,})[\s\-/]*(\d{1,2})[\s\-/,]+(\d{2,4})$/.exec(s);
  if (m) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mon >= 0) return iso(fullYear(+m[3]), mon + 1, +m[2]);
  }

  // dd/mm/yyyy — or mm/dd/yyyy when the caller says so
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    // a value over 12 can only be the day, whatever the flag claims
    if (dayFirst || a > 12) return iso(y, b, a) ?? iso(y, a, b);
    return iso(y, a, b) ?? iso(y, b, a);
  }

  // an Excel serial that came through as text
  const n = Number(s);
  if (Number.isFinite(n)) return fromExcelSerial(n);
  return null;
}

function fullYear(y: number): number {
  return y >= 100 ? y : y >= 70 ? 1900 + y : 2000 + y;
}

/**
 * Rupees → paise, signed.
 *
 * Handles what statements actually print: `₹1,23,456.78`, `(450.00)` for a
 * negative, a trailing `Dr` (money out) or `Cr` (money in), and a stray
 * non-breaking space. Returns null for anything it cannot read — a blank cell
 * included, since a debit/credit pair leaves one of the two empty on every row.
 */
export function parseImportAmount(raw: CellValue): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  }
  let s = String(raw).replace(/[ \s]/g, "").trim();
  if (!s) return null;

  let sign = 1;
  const drcr = /(dr|cr)\.?$/i.exec(s);
  if (drcr) {
    sign = drcr[1].toLowerCase() === "dr" ? -1 : 1;
    s = s.slice(0, drcr.index);
  }
  if (/^\(.*\)$/.test(s)) { sign = -sign; s = s.slice(1, -1); }
  s = s.replace(/[₹$€£,]/g, "");
  if (s.startsWith("-")) { sign = -sign; s = s.slice(1); }
  else if (s.startsWith("+")) s = s.slice(1);
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return sign * Math.round(n * 100);
}

export function cellText(raw: CellValue): string {
  if (raw === null || raw === undefined) return "";
  if (raw instanceof Date) return parseImportDate(raw) ?? "";
  return String(raw).trim();
}

// ---------------------------------------------------------------- column mapping

/**
 * What one spreadsheet column means.
 *
 * `amount` is signed and stands alone; `debit`/`credit` are the pair a bank
 * statement prints instead, where the row's direction comes from which of the
 * two is filled. A file may use either convention, never both.
 */
export type SheetColumn =
  | "ignore"
  | "date"
  | "description"
  | "from"
  | "to"
  | "amount"
  | "debit"
  | "credit"
  | "status"
  | "tag"
  | "notes";

const HEADER_HINTS: [SheetColumn, RegExp][] = [
  ["date", /^(date|txn.?date|value.?date|transaction.?date|posted|when)$/i],
  ["description", /^(desc|description|narration|particulars|details|remarks|title|name|payee|merchant)$/i],
  ["from", /^(from|source|paid.?from|from.?account|debit.?account)$/i],
  ["to", /^(to|category|dest|destination|paid.?to|to.?account|credit.?account)$/i],
  ["debit", /^(debit|withdrawal|withdrawals?|dr|money.?out|paid.?out|outflow|spent)$/i],
  ["credit", /^(credit|deposit|deposits?|cr|money.?in|paid.?in|inflow|received)$/i],
  ["amount", /^(amount|amt|value|sum|total|₹|rupees)$/i],
  ["status", /^(status|state|cleared|pending)$/i],
  ["tag", /^(tag|tags|label|labels)$/i],
  ["notes", /^(notes?|note|memo|comment|comments|reference|ref)$/i],
];

/**
 * A first guess at what each column is, from its header.
 *
 * Only a guess: it is what the mapping UI opens on, never what it does. A
 * meaning is claimed once — a sheet with two "Amount" columns must not silently
 * import the second one over the first.
 */
export function guessColumns(header: CellValue[]): SheetColumn[] {
  const taken = new Set<SheetColumn>();
  return header.map((h) => {
    const name = cellText(h).replace(/[\s._-]+/g, "");
    for (const [col, re] of HEADER_HINTS) {
      if (taken.has(col)) continue;
      if (re.test(cellText(h)) || re.test(name)) {
        taken.add(col);
        return col;
      }
    }
    return "ignore" as SheetColumn;
  });
}

/** Does the first row look like headers rather than data? */
export function looksLikeHeader(row: CellValue[]): boolean {
  if (row.length === 0) return false;
  const cells = row.map(cellText).filter((c) => c !== "");
  if (cells.length === 0) return false;
  // a header has no dates and no amounts in it
  return !cells.some((c) => parseImportDate(c) !== null || parseImportAmount(c) !== null);
}

/** How the caller wants a sheet read. */
export interface SheetMapping {
  /** One meaning per column, positionally. */
  columns: SheetColumn[];
  /** Skip the first row. */
  hasHeader: boolean;
  /** `03/04` is 3 April. */
  dayFirst: boolean;
  /**
   * Whose statement this is. Used for the side a row does not name — on a
   * bank export every line is "this account and someone else".
   */
  accountId: string | null;
  /** Where an unnamed outgoing row lands (an expense category). */
  spendToId: string | null;
  /** Where an unnamed incoming row comes from (an income source). */
  receiveFromId: string | null;
  /** A `from`/`to` name matching no account: mint it, or fail the row. */
  createMissing: boolean;
  /** Rows that match an entry already in the book. */
  onDuplicate: "skip" | "import";
}

// ---------------------------------------------------------------- the plan

export interface PlannedEntry {
  /** 1-based line in the source file, so a problem can be pointed at. */
  row: number;
  date: string;
  description: string;
  fromAccountId: string;
  toAccountId: string;
  amountPaise: number;
  status: TxnStatus;
  tag: string | null;
  notes: string | null;
  /** Names the entry names an account this same import creates. */
  duplicate: boolean;
}

export interface PlannedAccount {
  id: string;
  name: string;
  kind: AccountKind;
  subtype: AccountSubtype;
  /**
   * The archive row this account came from, when it came from one.
   *
   * A restored credit card has to come back with its statement day and limit
   * or the card cycles are wrong; an envelope has to come back with its liquid
   * flag. The plan stays a thin, renderable thing — the detail rides along
   * here until `planToOps` needs it.
   */
  detail?: Partial<Account>;
}

export interface RowProblem {
  row: number;
  message: string;
}

export interface ImportPlan {
  entries: PlannedEntry[];
  accounts: PlannedAccount[];
  problems: RowProblem[];
  /** Rows recognised as already in the book. Counted whether skipped or kept. */
  duplicates: number;
  /** Rows read from the file, headers excluded. */
  rowsRead: number;
}

/** What the book already holds, for matching names and spotting repeats. */
export interface ImportContext {
  ledgerId: string;
  accounts: Account[];
  transactions: Transaction[];
  postings: Posting[];
  /** Mints an id for anything created. Passed in so this stays pure. */
  newId: () => string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** date + amount + description — the three things a re-exported statement repeats. */
function duplicateKeys(ctx: ImportContext): Set<string> {
  const byTxn = new Map<string, number>();
  for (const p of ctx.postings) {
    if (p.amount_paise > 0) {
      byTxn.set(p.transaction_id, Math.max(byTxn.get(p.transaction_id) ?? 0, p.amount_paise));
    }
  }
  return new Set(
    ctx.transactions.map(
      (t) => `${t.date}|${byTxn.get(t.id) ?? 0}|${norm(t.description)}`
    )
  );
}

const dupKey = (e: { date: string; amountPaise: number; description: string }) =>
  `${e.date}|${e.amountPaise}|${norm(e.description)}`;

/**
 * Resolves account names to ids, minting the ones that are new.
 *
 * A name repeated down a column must become one account, not one per row, so
 * every mint is remembered. What kind of account to mint is decided by which
 * side of the entry the name appeared on: money leaving something unknown is
 * income, money arriving somewhere unknown is a spending category. That is a
 * guess, and it is the one the preview shows so it can be corrected before it
 * is written.
 */
class AccountResolver {
  readonly created: PlannedAccount[] = [];
  private readonly byName = new Map<string, string>();

  constructor(private readonly ctx: ImportContext, private readonly create: boolean) {
    for (const a of ctx.accounts) {
      if (!this.byName.has(norm(a.name))) this.byName.set(norm(a.name), a.id);
    }
  }

  /** @returns an account id, or null when the name is new and minting is off. */
  resolve(name: string, side: "from" | "to"): string | null {
    const key = norm(name);
    if (!key) return null;
    const found = this.byName.get(key);
    if (found) return found;
    if (!this.create) return null;

    const id = this.ctx.newId();
    const account: PlannedAccount = side === "from"
      ? { id, name: name.trim(), kind: "income", subtype: "other_income" }
      : { id, name: name.trim(), kind: "expense", subtype: "general_expense" };
    this.byName.set(key, id);
    this.created.push(account);
    return id;
  }
}

/**
 * Read a sheet into a plan.
 *
 * Direction is the whole game. When a row names both sides, the columns have
 * already said which way the money went and the amount's sign is ignored —
 * that is what makes our own `entries.csv` round-trip exactly. When a row names
 * one side or neither, the sign (or which of debit/credit is filled) decides,
 * and the mapping's three account fields fill the rest in.
 */
export function planSheet(
  rows: CellValue[][],
  mapping: SheetMapping,
  ctx: ImportContext
): ImportPlan {
  const problems: RowProblem[] = [];
  const entries: PlannedEntry[] = [];
  const resolver = new AccountResolver(ctx, mapping.createMissing);
  const existing = duplicateKeys(ctx);
  const seen = new Set<string>();
  let duplicates = 0;

  const col = (c: SheetColumn) => mapping.columns.indexOf(c);
  const idx = {
    date: col("date"), description: col("description"), from: col("from"),
    to: col("to"), amount: col("amount"), debit: col("debit"), credit: col("credit"),
    status: col("status"), tag: col("tag"), notes: col("notes"),
  };

  if (idx.date < 0) problems.push({ row: 0, message: "No column is mapped to the date." });
  if (idx.amount < 0 && idx.debit < 0 && idx.credit < 0) {
    problems.push({ row: 0, message: "No column is mapped to an amount (or to debit/credit)." });
  }
  if (problems.length > 0) {
    return { entries: [], accounts: [], problems, duplicates: 0, rowsRead: 0 };
  }

  const body = mapping.hasHeader ? rows.slice(1) : rows;
  const offset = mapping.hasHeader ? 2 : 1; // 1-based, and past the header

  body.forEach((raw, i) => {
    const line = i + offset;
    const at = (n: number): CellValue => (n >= 0 ? raw[n] : null);
    const fail = (message: string) => problems.push({ row: line, message });

    const date = parseImportDate(at(idx.date), mapping.dayFirst);
    if (!date) {
      fail(`Could not read a date from “${cellText(at(idx.date))}”.`);
      return;
    }

    // signed: negative is money leaving the account this sheet belongs to
    let signed: number | null = null;
    if (idx.amount >= 0) signed = parseImportAmount(at(idx.amount));
    if (signed === null || signed === 0) {
      const debit = idx.debit >= 0 ? parseImportAmount(at(idx.debit)) : null;
      const credit = idx.credit >= 0 ? parseImportAmount(at(idx.credit)) : null;
      if (debit) signed = -Math.abs(debit);
      else if (credit) signed = Math.abs(credit);
    }
    if (signed === null || signed === 0) {
      fail("No amount on this row.");
      return;
    }

    const outgoing = signed < 0;
    const amountPaise = Math.abs(signed);

    const fromName = cellText(at(idx.from));
    const toName = cellText(at(idx.to));
    let fromId = fromName ? resolver.resolve(fromName, "from") : null;
    let toId = toName ? resolver.resolve(toName, "to") : null;

    if (fromName && !fromId) { fail(`No account named “${fromName}”.`); return; }
    if (toName && !toId) { fail(`No account named “${toName}”.`); return; }

    if (!fromId && !toId) {
      fromId = outgoing ? mapping.accountId : mapping.receiveFromId;
      toId = outgoing ? mapping.spendToId : mapping.accountId;
    } else if (!fromId) {
      fromId = outgoing ? mapping.accountId : mapping.receiveFromId;
    } else if (!toId) {
      toId = outgoing ? mapping.spendToId : mapping.accountId;
    }

    if (!fromId || !toId) {
      fail("This row names only one account, and no fallback is set for the other side.");
      return;
    }
    if (fromId === toId) {
      fail("Both sides of this row are the same account.");
      return;
    }

    const description = cellText(at(idx.description)) || "Imported entry";
    const statusText = cellText(at(idx.status)).toLowerCase();
    const status: TxnStatus =
      statusText === "pending" || statusText === "planned" ? "pending" : "done";

    const entry: PlannedEntry = {
      row: line, date, description, fromAccountId: fromId, toAccountId: toId,
      amountPaise, status,
      tag: cellText(at(idx.tag)) || null,
      notes: cellText(at(idx.notes)) || null,
      duplicate: false,
    };

    const key = dupKey(entry);
    // a repeat inside the file counts too — statements overlap at the edges
    entry.duplicate = existing.has(key) || seen.has(key);
    seen.add(key);
    if (entry.duplicate) {
      duplicates++;
      if (mapping.onDuplicate === "skip") return;
    }
    entries.push(entry);
  });

  return {
    entries,
    accounts: resolver.created,
    problems,
    duplicates,
    rowsRead: body.length,
  };
}

// ---------------------------------------------------------------- restore

/** The shape `exportJson` writes. Everything is checked before it is trusted. */
export interface ArchiveBundle {
  format?: string;
  version?: number;
  accounts?: Partial<Account>[];
  transactions?: Partial<Transaction>[];
  postings?: Partial<Posting>[];
  recurring_templates?: unknown[];
}

export const ARCHIVE_FORMAT = "munshi.ledger";

/** Is this parsed JSON one of our archives? Returns why not, when it isn't. */
export function readArchive(json: unknown): { bundle: ArchiveBundle } | { error: string } {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { error: "That file is not a Munshi archive." };
  }
  const b = json as ArchiveBundle;
  if (b.format !== ARCHIVE_FORMAT) {
    return { error: `That file is not a Munshi archive (its format is “${b.format ?? "unknown"}”).` };
  }
  if (!Array.isArray(b.accounts) || !Array.isArray(b.transactions) || !Array.isArray(b.postings)) {
    return { error: "The archive is missing accounts, transactions or postings." };
  }
  return { bundle: b };
}

/**
 * Restore an archive into a book.
 *
 * The archive's ids are never reused. It may be restored into a book that
 * already has rows — a second device, a rebuilt ledger, an accident being
 * undone — so an account is matched to an existing one by name and subtype
 * when there is one, and minted otherwise; postings are then remapped onto
 * whichever it turned out to be. Matching by name is what stops a restore
 * from producing a second "ICICI" beside the first.
 *
 * Only two-leg-or-more entries whose legs all resolve are planned; anything
 * else is reported rather than half-written.
 */
export function planRestore(
  bundle: ArchiveBundle,
  ctx: ImportContext,
  { onDuplicate = "skip" as "skip" | "import" } = {}
): ImportPlan {
  const problems: RowProblem[] = [];
  const created: PlannedAccount[] = [];
  const idMap = new Map<string, string>();

  const existingByKey = new Map<string, string>();
  for (const a of ctx.accounts) {
    existingByKey.set(`${norm(a.name)}|${a.subtype}`, a.id);
  }

  (bundle.accounts ?? []).forEach((a, i) => {
    if (!a.id || !a.name || !a.kind || !a.subtype) {
      problems.push({ row: i + 1, message: `Account ${i + 1} in the archive is incomplete.` });
      return;
    }
    const match = existingByKey.get(`${norm(a.name)}|${a.subtype}`);
    if (match) {
      idMap.set(a.id, match);
      return;
    }
    const id = ctx.newId();
    idMap.set(a.id, id);
    existingByKey.set(`${norm(a.name)}|${a.subtype}`, id);
    created.push({ id, name: a.name, kind: a.kind, subtype: a.subtype, detail: a });
  });

  const legs = new Map<string, Posting[]>();
  for (const p of bundle.postings ?? []) {
    if (!p.transaction_id) continue;
    const list = legs.get(p.transaction_id);
    if (list) list.push(p as Posting);
    else legs.set(p.transaction_id, [p as Posting]);
  }

  const existing = duplicateKeys(ctx);
  const entries: PlannedEntry[] = [];
  let duplicates = 0;

  (bundle.transactions ?? []).forEach((t, i) => {
    const line = i + 1;
    if (!t.id || !t.date || !t.description) {
      problems.push({ row: line, message: `Entry ${line} in the archive is incomplete.` });
      return;
    }
    const rows = legs.get(t.id) ?? [];
    if (rows.length < 2) {
      problems.push({ row: line, message: `“${t.description}” has no legs in the archive.` });
      return;
    }
    const debits = rows.filter((p) => p.amount_paise > 0);
    const credits = rows.filter((p) => p.amount_paise < 0);
    if (debits.length === 0 || credits.length !== 1) {
      problems.push({
        row: line,
        message: `“${t.description}” has a leg shape this restore cannot rebuild.`,
      });
      return;
    }
    const to = debits.slice().sort((a, b) => b.amount_paise - a.amount_paise)[0];
    const from = credits[0];
    const fromId = idMap.get(from.account_id);
    const toId = idMap.get(to.account_id);
    if (!fromId || !toId) {
      problems.push({ row: line, message: `“${t.description}” names an account the archive does not hold.` });
      return;
    }

    const entry: PlannedEntry = {
      row: line,
      date: t.date,
      description: t.description,
      fromAccountId: fromId,
      toAccountId: toId,
      amountPaise: -from.amount_paise,
      status: t.status === "pending" ? "pending" : "done",
      tag: t.tag ?? null,
      notes: t.notes ?? null,
      duplicate: false,
    };
    // a split's extra legs are dropped rather than guessed at; say so
    if (debits.length > 1) {
      problems.push({
        row: line,
        message: `“${t.description}” was split across ${debits.length} accounts — restored against ${
          created.find((c) => c.id === toId)?.name ?? ctx.accounts.find((a) => a.id === toId)?.name ?? "one"
        } only.`,
      });
    }
    entry.duplicate = existing.has(dupKey(entry));
    if (entry.duplicate) {
      duplicates++;
      if (onDuplicate === "skip") return;
    }
    entries.push(entry);
  });

  return {
    entries,
    accounts: created,
    problems,
    duplicates,
    rowsRead: (bundle.transactions ?? []).length,
  };
}

// ---------------------------------------------------------------- ops

/**
 * The plan, as the ops that write it.
 *
 * Accounts first, because an entry may post against one this same batch
 * creates and `validateBatch` walks in order. The whole list goes to
 * `applyAll` as one thing: an import the user approved as 200 entries must not
 * land as 140.
 */
export function planToOps(plan: ImportPlan, ledgerId: string): LedgerOp[] {
  const ops: LedgerOp[] = plan.accounts.map((a) => {
    const archived = a.detail;
    const account: NewAccount & { id: string } = {
      id: a.id,
      ledger_id: ledgerId,
      name: a.name,
      kind: a.kind,
      subtype: a.subtype,
      // a parent from the archive is an archive id; remap is not available
      // here, so a restored child comes back at the top level rather than
      // under something that may not exist. The preview says as much.
      parent_id: null,
      statement_day: archived?.statement_day ?? null,
      due_day: archived?.due_day ?? null,
      credit_limit_paise: archived?.credit_limit_paise ?? null,
      person_name: archived?.person_name ?? (a.subtype === "receivable" ? a.name : null),
      reported_balance_paise: null,
      reported_at: null,
      sort_order: archived?.sort_order ?? 0,
      archived: false,
      is_liquid: archived?.is_liquid ?? ["bank", "cash", "envelope"].includes(a.subtype),
    };
    return accountCreateOp(account);
  });

  for (const e of plan.entries) {
    ops.push(
      entryCreateOp({
        ledgerId,
        date: e.date,
        description: e.description,
        status: e.status,
        fromAccountId: e.fromAccountId,
        toAccountId: e.toAccountId,
        amountPaise: e.amountPaise,
        tag: e.tag,
        notes: e.notes,
      })
    );
  }
  return ops;
}

/** A one-line summary of what approving the plan will do. */
export function describePlan(plan: ImportPlan): string {
  const bits = [`${plan.entries.length} ${plan.entries.length === 1 ? "entry" : "entries"}`];
  if (plan.accounts.length > 0) {
    bits.push(`${plan.accounts.length} new ${plan.accounts.length === 1 ? "account" : "accounts"}`);
  }
  if (plan.duplicates > 0) bits.push(`${plan.duplicates} already in the book`);
  if (plan.problems.length > 0) {
    bits.push(`${plan.problems.length} ${plan.problems.length === 1 ? "row" : "rows"} skipped`);
  }
  return bits.join(" · ");
}

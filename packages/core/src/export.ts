/**
 * Taking the book with you.
 *
 * Once a ledger is encrypted the server holds ciphertext and nothing else —
 * no admin console, no SQL client, nobody at all can hand you a copy of your
 * own data (docs/E2EE.md §8). Export is therefore not a convenience feature,
 * it is the only exit. It runs where the key is, on decrypted rows, and it is
 * pure: give it a snapshot, get back files.
 *
 * Two shapes, because they answer different questions:
 *
 * - **JSON** — the whole book, ids intact, nothing flattened or rounded. This
 *   is the one that could be imported back or diffed; it is the archive.
 * - **CSV** — one file per table, ids resolved to names and paise rendered as
 *   rupees, so a spreadsheet shows something a human can read. Lossy on
 *   purpose; `entries.csv` is the flat "what did I spend" sheet people
 *   actually want, and it is derived, not stored.
 */
import type {
  Account,
  Ledger,
  Posting,
  RecurringTemplate,
  Transaction,
} from "./types";
import { accountById } from "./calc";
import { formatPaisePlain } from "./money";

/** Everything an export reads. Exactly a decrypted `LedgerSnapshot` plus who it belongs to. */
export interface ExportInput {
  ledger: Pick<Ledger, "id" | "name"> | null;
  accounts: Account[];
  transactions: Transaction[];
  postings: Posting[];
  templates: RecurringTemplate[];
}

/** A file ready to be written or downloaded. */
export interface ExportFile {
  name: string;
  mime: string;
  content: string;
}

export const EXPORT_FORMAT_VERSION = 1;

/**
 * The archive: every row, verbatim, minus the ciphertext.
 *
 * `payload` is dropped on the way out — it is the encrypted copy of the very
 * fields sitting beside it in plaintext here, so keeping it would double the
 * file and leak nothing useful without the key.
 */
export function exportJson(input: ExportInput, exportedAt = new Date()): ExportFile {
  const strip = <T extends { payload?: string | null }>(rows: T[]) =>
    rows.map(({ payload: _payload, ...rest }) => rest);

  const bundle = {
    format: "munshi.ledger",
    version: EXPORT_FORMAT_VERSION,
    exported_at: exportedAt.toISOString(),
    ledger: input.ledger,
    accounts: strip(input.accounts),
    transactions: strip(input.transactions),
    postings: strip(input.postings),
    recurring_templates: strip(input.templates),
  };
  return {
    name: `${slug(input.ledger?.name)}-${stamp(exportedAt)}.json`,
    mime: "application/json",
    content: JSON.stringify(bundle, null, 2),
  };
}

/** RFC 4180: quote everything, double the quotes inside. Excel opens it, sheets opens it. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `"${String(v).replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * The flat sheet: one line per entry, the way the ledger reads on screen.
 *
 * An entry's legs are `from` (the credit) and `to` (the debit); a split entry
 * has more than two, so the extra legs go in `other_legs` rather than being
 * silently dropped. The amount is the largest debit — the same number the
 * Book shows.
 */
function entryRows(input: ExportInput): unknown[][] {
  const byTxn = new Map<string, Posting[]>();
  for (const p of input.postings) {
    const list = byTxn.get(p.transaction_id);
    if (list) list.push(p);
    else byTxn.set(p.transaction_id, [p]);
  }
  const name = (id: string | null) =>
    id ? (accountById(input.accounts, id)?.name ?? id) : "";

  return [...input.transactions]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((t) => {
      const legs = byTxn.get(t.id) ?? [];
      const debits = legs.filter((p) => p.amount_paise > 0);
      const credits = legs.filter((p) => p.amount_paise < 0);
      const to = debits.slice().sort((a, b) => b.amount_paise - a.amount_paise)[0];
      const from = credits.slice().sort((a, b) => a.amount_paise - b.amount_paise)[0];
      const rest = legs.filter((p) => p !== to && p !== from);
      return [
        t.date,
        t.description,
        name(from?.account_id ?? null),
        name(to?.account_id ?? null),
        to ? formatPaisePlain(to.amount_paise) : "",
        t.status,
        t.tag ?? "",
        t.notes ?? "",
        rest
          .map((p) => `${name(p.account_id)} ${formatPaisePlain(p.amount_paise)}`)
          .join("; "),
        t.id,
      ];
    });
}

/** One CSV per table, plus the derived flat entry sheet. */
export function exportCsvs(input: ExportInput): ExportFile[] {
  const name = (id: string | null) =>
    id ? (accountById(input.accounts, id)?.name ?? id) : "";
  const csv = (file: string, headers: string[], rows: unknown[][]): ExportFile => ({
    name: file,
    mime: "text/csv;charset=utf-8",
    content: toCsv(headers, rows),
  });

  return [
    csv("entries.csv",
      ["date", "description", "from", "to", "amount", "status", "tag", "notes", "other_legs", "transaction_id"],
      entryRows(input)),

    csv("accounts.csv",
      ["name", "kind", "subtype", "parent", "is_liquid", "archived", "statement_day",
       "due_day", "credit_limit", "person_name", "reported_balance", "reported_at", "id"],
      input.accounts.map((a) => [
        a.name, a.kind, a.subtype, name(a.parent_id), a.is_liquid, a.archived,
        a.statement_day ?? "", a.due_day ?? "",
        a.credit_limit_paise === null ? "" : formatPaisePlain(a.credit_limit_paise),
        a.person_name ?? "",
        a.reported_balance_paise === null ? "" : formatPaisePlain(a.reported_balance_paise),
        a.reported_at ?? "", a.id,
      ])),

    csv("postings.csv",
      ["transaction_id", "date", "description", "account", "amount", "posting_id"],
      input.postings.map((p) => {
        const t = input.transactions.find((x) => x.id === p.transaction_id);
        return [
          p.transaction_id, t?.date ?? "", t?.description ?? "",
          name(p.account_id), formatPaisePlain(p.amount_paise), p.id,
        ];
      })),

    csv("recurring.csv",
      ["name", "kind", "day_of_month", "amount", "from", "to", "is_budget",
       "installments_done", "total_installments", "repaid_by", "repay_amount",
       "repay_day", "start_date", "end_date", "active", "notes", "id"],
      input.templates.map((t) => [
        t.name, t.kind, t.day_of_month, formatPaisePlain(t.amount_paise),
        name(t.from_account_id), name(t.to_account_id), t.is_budget,
        t.installments_done, t.total_installments ?? "",
        name(t.reimburse_account_id),
        t.reimburse_amount_paise === null ? "" : formatPaisePlain(t.reimburse_amount_paise),
        t.reimburse_expected_day ?? "",
        t.start_date ?? "", t.end_date ?? "", t.active, t.notes ?? "", t.id,
      ])),
  ];
}

function slug(name: string | undefined | null): string {
  const s = (name ?? "munshi").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s || "munshi";
}

/** Local yyyy-mm-dd — a file named for the day you asked for it, not for UTC's. */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `entries.csv` → `my-book-2026-08-31-entries.csv`. */
export function exportFileName(
  ledgerName: string | undefined | null,
  file: string,
  at = new Date()
): string {
  return `${slug(ledgerName)}-${stamp(at)}-${file}`;
}

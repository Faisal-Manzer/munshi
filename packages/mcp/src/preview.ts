/**
 * The thing the user actually reads before approving.
 *
 * Three parts, in this order, always (docs/MCP.md §4):
 *
 *   1. the double-entry — VISION §1 is explicit that trust is built by showing
 *      the postings, not by hiding them;
 *   2. before→after for every account the operation moves, because postings
 *      alone do not tell you whether you can afford it;
 *   3. a sentence in ordinary words, because most people should not have to
 *      read the first two to know what they are agreeing to.
 *
 * A preview is data first and text second: the structure is what a richer
 * client renders, and `renderPreview` is the fallback for the ones that only
 * take a string.
 */
import {
  accountById,
  displayBalance,
  formatPaise,
  type Account,
  type LedgerOp,
} from "@munshi/core";
import { computeBalances, type AccountBalance } from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { affectedAccountIds, simulate } from "./simulate";

export interface PreviewPosting {
  account: string;
  /** Positive is a debit, negative a credit — the ledger's own convention. */
  amountPaise: number;
}

export interface PreviewEntry {
  date: string;
  description: string;
  status: "pending" | "done";
  postings: PreviewPosting[];
}

export interface PreviewDelta {
  account: string;
  /** Sign-corrected for reading: a liability shows what is owed, positive. */
  beforePaise: number;
  afterPaise: number;
}

/** An extra block a specific operation wants shown — an EMI schedule, a match list. */
export interface PreviewSection {
  heading: string;
  /** Rendered as an aligned table; the first row may be a header. */
  rows: string[][];
  header?: boolean;
}

export interface Preview {
  title: string;
  entries: PreviewEntry[];
  deltas: PreviewDelta[];
  /** Plain English. What this means, not what it does to the schema. */
  explanation: string;
  sections: PreviewSection[];
  /** Anything the user should know before approving — limits, assumptions, risks. */
  warnings: string[];
  /** Rows that change without producing a posting: a new account, a renamed tag. */
  changes: string[];
}

export interface PreviewInput {
  title: string;
  explanation: string;
  sections?: PreviewSection[];
  warnings?: string[];
}

const nameOf = (accounts: Account[], id: string) =>
  accountById(accounts, id)?.name ?? "(unknown account)";

/**
 * Balances are read after simulating, and read *for the simulated accounts*,
 * so an operation that both creates an account and posts to it shows a real
 * before (zero) and after rather than "unknown".
 */
export function buildPreview(
  snapshot: LedgerSnapshot,
  ops: LedgerOp[],
  input: PreviewInput
): Preview {
  const after = simulate(snapshot, ops);
  const before = computeBalances(snapshot);
  const afterBalances = computeBalances(after);
  const ids = affectedAccountIds(snapshot, ops);

  const entries: PreviewEntry[] = ops.flatMap((op) =>
    op.kind === "entry.create" || op.kind === "entry.rewrite"
      ? [
          {
            date: op.txn.date,
            description: op.txn.description,
            status: op.txn.status,
            postings: op.postings.map((p) => ({
              account: nameOf(after.accounts, p.account_id),
              amountPaise: p.amount_paise,
            })),
          },
        ]
      : []
  );

  const deltas: PreviewDelta[] = [];
  for (const id of ids) {
    const account = accountById(after.accounts, id);
    if (!account) continue;
    // flipping the sign of a zero balance yields -0, which compares equal but
    // renders as "-₹0.00" in anything that formats the raw number
    const raw = (m: Map<string, AccountBalance>) => m.get(id)?.balance_paise ?? 0;
    const shown = (paise: number) => displayBalance(account, paise) || 0;
    const beforePaise = shown(raw(before));
    const afterPaise = shown(raw(afterBalances));
    if (beforePaise === afterPaise) continue; // an untouched number is noise
    deltas.push({ account: account.name, beforePaise, afterPaise });
  }

  const changes = ops.flatMap((op) => {
    switch (op.kind) {
      case "account.create":
        return [`New account: ${op.account.name} (${op.account.kind}/${op.account.subtype})`];
      case "account.update":
        return [`${op.current.name}: ${Object.keys(op.patch).join(", ")} updated`];
      case "template.create":
        return [`New recurring: ${op.template.name}, day ${op.template.day_of_month}`];
      case "template.update":
        return [`${op.current.name}: ${Object.keys(op.patch).join(", ")} updated`];
      case "entry.patch":
        return [`${op.current.description}: ${Object.keys(op.patch).join(", ")} updated`];
      case "entry.delete":
        return [`Deleted entry ${op.transactionId}`];
      default:
        return [];
    }
  });

  return {
    title: input.title,
    entries,
    deltas,
    explanation: input.explanation,
    sections: input.sections ?? [],
    warnings: input.warnings ?? [],
    changes,
  };
}

// ---- rendering -------------------------------------------------------------

function table(rows: string[][], indent = "  "): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map(
    (row) =>
      indent +
      row
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
        .join("   ")
        .trimEnd()
  );
}

/** Debits left, credits right — the shape an accountant expects to see. */
function entryLines(entry: PreviewEntry): string[] {
  return table(
    entry.postings.map((p) => [
      p.amountPaise >= 0 ? `Dr  ${p.account}` : `Cr  ${p.account}`,
      formatPaise(Math.abs(p.amountPaise)),
    ])
  );
}

export function renderPreview(p: Preview): string {
  const out: string[] = [p.title, ""];

  for (const entry of p.entries) {
    out.push(`${entry.date}  ${entry.description}${entry.status === "pending" ? "  (pending)" : ""}`);
    out.push(...entryLines(entry));
    out.push("");
  }

  if (p.changes.length) {
    out.push(...p.changes.map((c) => `  ${c}`), "");
  }

  if (p.deltas.length) {
    out.push(
      ...table(
        p.deltas.map((d) => [
          d.account,
          formatPaise(d.beforePaise),
          "→",
          formatPaise(d.afterPaise),
        ])
      ),
      ""
    );
  }

  for (const section of p.sections) {
    out.push(`  ${section.heading}`, ...table(section.rows, "    "), "");
  }

  out.push(p.explanation, "");
  if (p.warnings.length) out.push(...p.warnings.map((w) => `! ${w}`), "");

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

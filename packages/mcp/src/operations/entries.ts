/**
 * Entries: the ordinary case, and the one that has to be effortless.
 *
 * "paid 450 for chai with Faraz, split half" is the shape VISION §1 promises,
 * so the input here is what a person says — from, to, amount, who owes part of
 * it back — and the double-entry is derived by the same `buildPostings` the UI
 * uses. Nothing about splits or reimbursement is reimplemented for MCP.
 */
import {
  entryCreateOp,
  entryDeleteOp,
  entryPatchOp,
  entryRewriteOp,
  formatPaise,
  type EntryInput,
  type LedgerOp,
  type Transaction,
} from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { McpError } from "../errors";
import { buildPreview } from "../preview";
import { postedInMonth, requireTemplate } from "./templates";
import type { Operation } from "./types";

export interface EntryOperationInput extends EntryInput {
  /** Warn when an identical entry already sits in the book on the same day. */
  allowDuplicate?: boolean;
}

function requireAccount(snapshot: LedgerSnapshot, id: string, role: string) {
  const account = snapshot.accounts.find((a) => a.id === id);
  if (!account) throw new McpError("NOT_FOUND", `No ${role} account ${id} in this book.`);
  return account;
}

const nameOf = (snapshot: LedgerSnapshot, id: string) =>
  snapshot.accounts.find((a) => a.id === id)?.name ?? id;

export function proposeEntry(
  snapshot: LedgerSnapshot,
  input: EntryOperationInput
): Operation {
  const from = requireAccount(snapshot, input.fromAccountId, "source");
  const to = requireAccount(snapshot, input.toAccountId, "destination");
  if (input.amountPaise <= 0) {
    throw new McpError("UNBALANCED", "An entry needs an amount greater than zero.");
  }
  if (input.reimburseAccountId) requireAccount(snapshot, input.reimburseAccountId, "person");
  const template = input.recurringTemplateId
    ? requireTemplate(snapshot, input.recurringTemplateId)
    : null;
  // an EMI run for someone else is owed by them in full: the person is also
  // the destination, so the "share" is the whole amount and not a split
  const owedWhole =
    input.reimburseAccountId === input.toAccountId && input.reimbursePaise === input.amountPaise;
  if (input.reimbursePaise && input.reimbursePaise >= input.amountPaise && !owedWhole) {
    throw new McpError(
      "UNBALANCED",
      `The reimbursed share (${formatPaise(input.reimbursePaise)}) must be less than the ` +
        `total (${formatPaise(input.amountPaise)}). If someone owes all of it, post it to them directly.`
    );
  }

  const twin = snapshot.transactions.find(
    (t) =>
      t.date === input.date &&
      t.description.trim().toLowerCase() === input.description.trim().toLowerCase()
  );
  if (twin && !input.allowDuplicate) {
    throw new McpError(
      "LIKELY_DUPLICATE",
      `"${input.description}" is already in the book on ${input.date}. ` +
        `Say so explicitly if this is a second, separate one.`,
      { candidates: [{ id: twin.id, date: twin.date, description: twin.description }] }
    );
  }

  const warnings: string[] = [];
  if (twin) {
    warnings.push(`A same-day entry called "${twin.description}" already exists; this adds a second one.`);
  }
  if (template) {
    if (postedInMonth(snapshot, template.id, input.date).length > 0) {
      warnings.push(`"${template.name}" is already posted for ${input.date.slice(0, 7)}.`);
    }
    if (
      template.from_account_id !== input.fromAccountId ||
      template.to_account_id !== input.toAccountId
    ) {
      warnings.push(`Linked to "${template.name}" but its accounts differ from the template's.`);
    }
  }

  const ops: LedgerOp[] = [entryCreateOp(input)];
  const reimbursed = owedWhole ? 0 : (input.reimbursePaise ?? 0);

  const explanation =
    reimbursed > 0 && input.reimburseAccountId
      ? `${formatPaise(input.amountPaise)} leaves ${from.name}. ` +
        `${formatPaise(input.amountPaise - reimbursed)} is yours; ` +
        `${nameOf(snapshot, input.reimburseAccountId)} owes you the other ${formatPaise(reimbursed)}.`
      : `${formatPaise(input.amountPaise)} moves from ${from.name} to ${to.name}` +
        `${input.status === "pending" ? ", once it settles" : ""}.`;

  return {
    ops,
    summary: `${input.description} — ${formatPaise(input.amountPaise)}`,
    preview: buildPreview(snapshot, ops, {
      title: `ENTRY — ${input.description}   ${formatPaise(input.amountPaise)}`,
      explanation,
      warnings,
    }),
  };
}

/** A transfer is an entry between two accounts you own — no expense involved. */
export function proposeTransfer(
  snapshot: LedgerSnapshot,
  input: Omit<EntryOperationInput, "reimburseAccountId" | "reimbursePaise">
): Operation {
  const op = proposeEntry(snapshot, input);
  return {
    ...op,
    preview: {
      ...op.preview,
      title: `TRANSFER — ${input.description}   ${formatPaise(input.amountPaise)}`,
    },
  };
}

/**
 * Rewrite an entry. A split the caller does not mention is kept: dropping
 * `reimburse_*` on an edit used to clear it silently, which loses what a
 * person owes on something as routine as fixing a date.
 */
export function proposeEntryEdit(
  snapshot: LedgerSnapshot,
  transactionId: string,
  input: Omit<EntryInput, "ledgerId">
): Operation {
  const current = snapshot.transactions.find((t) => t.id === transactionId);
  if (!current) throw new McpError("NOT_FOUND", `No entry ${transactionId} in this book.`);
  requireAccount(snapshot, input.fromAccountId, "source");
  requireAccount(snapshot, input.toAccountId, "destination");

  const keepSplit = input.reimburseAccountId === undefined && input.reimbursePaise === undefined;
  const reimburseAccountId = keepSplit ? current.reimburse_account_id : input.reimburseAccountId;
  let reimbursePaise = keepSplit ? current.reimburse_amount_paise : input.reimbursePaise;
  // owed in full stays owed in full when the amount changes
  if (keepSplit && reimburseAccountId && reimburseAccountId === input.toAccountId) {
    reimbursePaise = input.amountPaise;
  }
  if (reimburseAccountId) requireAccount(snapshot, reimburseAccountId, "person");

  const ops: LedgerOp[] = [
    entryRewriteOp(transactionId, { ...input, reimburseAccountId, reimbursePaise }),
  ];
  return {
    ops,
    summary: `Edit — ${current.description}`,
    preview: buildPreview(snapshot, ops, {
      title: `EDIT — ${current.description}`,
      explanation:
        `The entry is rewritten: its legs are replaced wholesale, so the balances below are ` +
        `the net effect of the change, not of the whole entry.`,
    }),
  };
}

export function proposeEntryDelete(
  snapshot: LedgerSnapshot,
  transactionId: string
): Operation {
  const current = snapshot.transactions.find((t) => t.id === transactionId);
  if (!current) throw new McpError("NOT_FOUND", `No entry ${transactionId} in this book.`);
  const ops: LedgerOp[] = [entryDeleteOp(transactionId)];
  return {
    ops,
    summary: `Delete — ${current.description}`,
    preview: buildPreview(snapshot, ops, {
      title: `DELETE — ${current.description} (${current.date})`,
      explanation: `The entry and both its legs are removed. This cannot be undone.`,
      warnings: ["Deleting is permanent. An adjustment entry keeps the history; this does not."],
    }),
  };
}

/** Settle a pending entry — the "it actually went through" case. */
export function proposeMarkDone(
  snapshot: LedgerSnapshot,
  transactionId: string,
  dateISO?: string
): Operation {
  const current = snapshot.transactions.find((t) => t.id === transactionId);
  if (!current) throw new McpError("NOT_FOUND", `No entry ${transactionId} in this book.`);
  if (current.status === "done") {
    throw new McpError("NOT_FOUND", `"${current.description}" is already settled.`);
  }
  const patch: Partial<Transaction> = { status: "done", ...(dateISO ? { date: dateISO } : {}) };
  const ops: LedgerOp[] = [entryPatchOp(current, patch)];
  return {
    ops,
    summary: `Settled — ${current.description}`,
    preview: buildPreview(snapshot, ops, {
      title: `SETTLE — ${current.description}`,
      explanation:
        `The amounts do not change; the entry moves from pending to settled, which is what ` +
        `moves it out of the plan and into what has actually happened.`,
    }),
  };
}

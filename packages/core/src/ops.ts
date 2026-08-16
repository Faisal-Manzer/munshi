/**
 * Building and checking batches of ops.
 *
 * A financial operation is a list of `LedgerOp`s that must be shown, approved
 * and written as one thing. Everything here is pure: it turns intent into
 * ops, and it says whether a batch is coherent — no storage, no ids invented
 * behind the caller's back, no clock.
 *
 * `validateBatch` is the guard that stands where the database used to. An
 * encrypted book gives Postgres nothing to check: it cannot sum postings, it
 * cannot see that an entry names an account from another ledger. So the rules
 * live here, and every write path runs them (docs/MCP.md §2).
 */
import { assertBalanced } from "./entries";
import type {
  AccountCreateOp,
  AccountUpdateOp,
  EntryDeleteOp,
  EntryPatchOp,
  LedgerOp,
  NewAccount,
  NewTemplate,
  TemplateCreateOp,
  TemplateUpdateOp,
} from "./store";
import type { Account, RecurringTemplate, Transaction } from "./types";

export function accountCreateOp(account: NewAccount & { id: string }): AccountCreateOp {
  return { kind: "account.create", account };
}

export function accountUpdateOp(
  current: Account,
  patch: Partial<Account>
): AccountUpdateOp {
  return { kind: "account.update", current, patch };
}

export function templateCreateOp(
  template: NewTemplate & { id: string }
): TemplateCreateOp {
  return { kind: "template.create", template };
}

export function templateUpdateOp(
  current: RecurringTemplate,
  patch: Partial<RecurringTemplate>
): TemplateUpdateOp {
  return { kind: "template.update", current, patch };
}

export function entryPatchOp(
  current: Transaction,
  patch: Partial<Transaction>
): EntryPatchOp {
  return { kind: "entry.patch", current, patch };
}

export function entryDeleteOp(transactionId: string): EntryDeleteOp {
  return { kind: "entry.delete", transactionId };
}

/** Every account id an op writes to or posts against. */
export function opAccountIds(op: LedgerOp): string[] {
  switch (op.kind) {
    case "entry.create":
    case "entry.rewrite":
      return op.postings.map((p) => p.account_id);
    case "account.create":
      return [op.account.id];
    case "account.update":
      return [op.current.id];
    case "template.create":
      return [op.template.from_account_id, op.template.to_account_id];
    case "template.update":
      return [op.current.from_account_id, op.current.to_account_id];
    default:
      return [];
  }
}

/** The ids a batch brings into existence, in order. */
export function createdIds(ops: LedgerOp[]): string[] {
  return ops.flatMap((op) =>
    op.kind === "account.create"
      ? [op.account.id]
      : op.kind === "template.create"
        ? [op.template.id]
        : []
  );
}

export interface BatchProblem {
  index: number;
  message: string;
}

/**
 * Check a batch without throwing: returns every problem, not just the first,
 * because a preview should be able to show the user all of what is wrong.
 *
 * @param knownAccountIds ids that already exist in the book. Accounts the
 *   batch itself creates are added as it walks, so ordering matters: an entry
 *   may post against an account created earlier in the same batch, never one
 *   created later.
 */
export function validateBatch(
  ops: LedgerOp[],
  knownAccountIds: Iterable<string> = []
): BatchProblem[] {
  const problems: BatchProblem[] = [];
  if (ops.length === 0) return [{ index: -1, message: "Batch is empty." }];

  const known = new Set(knownAccountIds);
  const minted = new Set<string>();

  ops.forEach((op, index) => {
    const fail = (message: string) => problems.push({ index, message });

    if (op.kind === "account.create" || op.kind === "template.create") {
      const id = op.kind === "account.create" ? op.account.id : op.template.id;
      if (!id) fail(`${op.kind} needs an id minted by the caller.`);
      else if (minted.has(id) || known.has(id)) fail(`Duplicate id ${id}.`);
      else minted.add(id);
      if (op.kind === "account.create") known.add(id);
    }

    if (op.kind === "entry.create" || op.kind === "entry.rewrite") {
      try {
        assertBalanced(op.postings);
      } catch (e) {
        fail(e instanceof Error ? e.message : "Entry does not balance.");
      }
    }

    // an op may only name accounts that exist, or that an earlier op created.
    // `known` is the account set specifically — a template id minted in this
    // same batch is not a thing you can post against.
    for (const accountId of opAccountIds(op)) {
      if (accountId && !known.has(accountId)) fail(`Unknown account ${accountId}.`);
    }
  });

  return problems;
}

export function assertBatchValid(
  ops: LedgerOp[],
  knownAccountIds: Iterable<string> = []
): void {
  const problems = validateBatch(ops, knownAccountIds);
  if (problems.length > 0) {
    throw new Error(
      `Invalid batch:\n${problems.map((p) => `  op ${p.index}: ${p.message}`).join("\n")}`
    );
  }
}

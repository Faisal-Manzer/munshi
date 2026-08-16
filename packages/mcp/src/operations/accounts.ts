/**
 * Creating an account — the one write with no postings of its own.
 *
 * Unless an opening balance is given, in which case it has to be balanced
 * against something, and that something is equity rather than income. A card
 * that already carries ₹48,320 is not this month's spending; booking it as
 * expense would make every "what did I spend" number wrong from the first day
 * (docs/MCP.md §4.1).
 */
import {
  accountById,
  accountCreateOp,
  formatPaise,
  type Account,
  type AccountKind,
  type AccountSubtype,
  type LedgerOp,
  type NewAccount,
} from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { McpError } from "../errors";
import { buildPreview } from "../preview";
import { uuid, type MintId, type Operation } from "./types";

/** The account shapes a user actually asks for, and what each means in the schema. */
export const ACCOUNT_TYPES = {
  bank: { kind: "asset", subtype: "bank", liquid: true, label: "Bank account" },
  cash: { kind: "asset", subtype: "cash", liquid: true, label: "Cash" },
  envelope: { kind: "asset", subtype: "envelope", liquid: true, label: "Envelope", parent: "bank" },
  investment: { kind: "asset", subtype: "investment", liquid: false, label: "Investment" },
  credit_card: { kind: "liability", subtype: "credit_card", liquid: false, label: "Credit card" },
  card_child: { kind: "liability", subtype: "credit_card", liquid: false, label: "Card sub-account", parent: "credit_card" },
  loan: { kind: "liability", subtype: "loan", liquid: false, label: "Loan you took" },
  person: { kind: "asset", subtype: "receivable", liquid: false, label: "Person" },
  expense: { kind: "expense", subtype: "general_expense", liquid: false, label: "Expense category" },
  income: { kind: "income", subtype: "salary", liquid: false, label: "Income source" },
} as const satisfies Record<
  string,
  { kind: AccountKind; subtype: AccountSubtype; liquid: boolean; label: string; parent?: string }
>;

export type AccountType = keyof typeof ACCOUNT_TYPES;

export interface AccountInput {
  ledgerId: string;
  type: AccountType;
  name: string;
  parentId?: string | null;
  statementDay?: number | null;
  dueDay?: number | null;
  creditLimitPaise?: number | null;
  openingBalancePaise?: number | null;
  isLiquid?: boolean;
  today: string;
}

/** The equity account an opening balance is booked against, found or minted. */
export function openingEquity(
  snapshot: LedgerSnapshot,
  ledgerId: string,
  mint: MintId
): { account: Account; op: LedgerOp | null } {
  const found = snapshot.accounts.find((a) => a.subtype === "opening_balance");
  if (found) return { account: found, op: null };
  const draft = blankAccount({
    id: mint(),
    ledgerId,
    name: "Opening balances",
    kind: "equity",
    subtype: "opening_balance",
    isLiquid: false,
  });
  return { account: draft as Account, op: accountCreateOp(draft) };
}

function blankAccount(x: {
  id: string;
  ledgerId: string;
  name: string;
  kind: AccountKind;
  subtype: AccountSubtype;
  isLiquid: boolean;
  parentId?: string | null;
  statementDay?: number | null;
  dueDay?: number | null;
  creditLimitPaise?: number | null;
  personName?: string | null;
}): NewAccount & { id: string } {
  return {
    id: x.id,
    ledger_id: x.ledgerId,
    name: x.name,
    kind: x.kind,
    subtype: x.subtype,
    parent_id: x.parentId ?? null,
    statement_day: x.statementDay ?? null,
    due_day: x.dueDay ?? null,
    credit_limit_paise: x.creditLimitPaise ?? null,
    person_name: x.personName ?? null,
    reported_balance_paise: null,
    reported_at: null,
    sort_order: 0,
    archived: false,
    is_liquid: x.isLiquid,
  };
}

export function proposeAccount(
  snapshot: LedgerSnapshot,
  input: AccountInput,
  mint: MintId = uuid
): Operation {
  const spec = ACCOUNT_TYPES[input.type];
  if (!spec) throw new McpError("NOT_FOUND", `Unknown account type "${input.type}".`);

  const needsParent = "parent" in spec ? (spec.parent as string) : null;
  if (needsParent && !input.parentId) {
    throw new McpError(
      "NOT_FOUND",
      `A ${spec.label.toLowerCase()} sits under a ${needsParent.replace("_", " ")} — name the parent account.`
    );
  }
  if (input.parentId && !accountById(snapshot.accounts, input.parentId)) {
    throw new McpError("NOT_FOUND", `No account ${input.parentId} in this book.`);
  }
  if (snapshot.accounts.some((a) => !a.archived && a.name.toLowerCase() === input.name.toLowerCase())) {
    throw new McpError(
      "LIKELY_DUPLICATE",
      `This book already has an account called "${input.name}".`
    );
  }

  const account = blankAccount({
    id: mint(),
    ledgerId: input.ledgerId,
    name: input.name,
    kind: spec.kind,
    subtype: spec.subtype,
    isLiquid: input.isLiquid ?? spec.liquid,
    parentId: input.parentId,
    statementDay: input.statementDay,
    dueDay: input.dueDay,
    creditLimitPaise: input.creditLimitPaise,
    personName: input.type === "person" ? input.name : null,
  });

  const ops: LedgerOp[] = [accountCreateOp(account)];
  const opening = input.openingBalancePaise ?? 0;
  const warnings: string[] = [];

  if (opening !== 0) {
    const equity = openingEquity(snapshot, input.ledgerId, mint);
    if (equity.op) ops.push(equity.op);
    // liabilities carry what is owed as a credit; assets as a debit
    const delta = spec.kind === "liability" ? -Math.abs(opening) : opening;
    ops.push({
      kind: "entry.create",
      ledgerId: input.ledgerId,
      txn: {
        date: input.today,
        description: `Opening balance — ${input.name}`,
        status: "done",
      },
      postings: [
        { account_id: account.id, amount_paise: delta },
        { account_id: equity.account.id, amount_paise: -delta },
      ],
    });
  } else {
    warnings.push(
      `No opening balance given — ${input.name} starts at zero. Reconcile it later if that is wrong.`
    );
  }

  const detail = [
    `kind ${spec.kind} / ${spec.subtype}`,
    input.statementDay ? `statement ${input.statementDay}` : null,
    input.dueDay ? `due ${input.dueDay}` : null,
    input.creditLimitPaise ? `limit ${formatPaise(input.creditLimitPaise)}` : null,
    `liquid ${(input.isLiquid ?? spec.liquid) ? "yes" : "no"}`,
  ].filter(Boolean) as string[];

  const explanation =
    opening === 0
      ? `${input.name} is added to the book with nothing in it. Nothing is posted.`
      : `${input.name} already holds ${formatPaise(Math.abs(opening))}. That lands as equity, ` +
        `not as ${spec.kind === "liability" ? "a spend" : "income"}, so this month's totals stay honest.`;

  return {
    ops,
    summary: `New account — ${input.name}`,
    preview: buildPreview(snapshot, ops, {
      title: `NEW ACCOUNT — ${input.name}`,
      explanation,
      sections: [{ heading: spec.label, rows: detail.map((d) => [d]) }],
      warnings,
    }),
  };
}

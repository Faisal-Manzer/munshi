/**
 * A card EMI is a purchase already made, billed to the card in slices.
 *
 * The trap this guards against: the purchase is usually already in the book as
 * one big spend. Adding an EMI on top of it counts the money twice. So the
 * operation looks for a matching entry on that card and either folds the
 * reversal into the same proposal or refuses and shows what it found
 * (docs/MCP.md §4.3).
 *
 * Card cycle figures come from `computeCardCycles`, not from a guess about
 * when the statement lands.
 */
import {
  computeBalances,
  computeCardCycles,
  displayBalance,
  formatPaise,
  isCard,
  subtreeBalance,
  templateCreateOp,
  type LedgerOp,
  type NewTemplate,
  type Transaction,
} from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { McpError } from "../errors";
import { buildPreview, type PreviewSection } from "../preview";
import { uuid, type MintId, type Operation } from "./types";

export interface CardEmiInput {
  ledgerId: string;
  cardId: string;
  description: string;
  /** The full purchase, not the monthly slice. */
  totalPaise: number;
  months: number;
  /** Category the spending lands in each month. */
  expenseAccountId: string;
  firstBillingISO: string;
  /** One-off fee the bank charges to convert. Posted separately when given. */
  processingFeePaise?: number | null;
  /**
   * Set once the user has been shown a possible duplicate and said it is not
   * one — or has asked for the original spend to be reversed.
   */
  duplicate?: "ignore" | "reverse";
  today: string;
}

/** Entries on this card, in the last 90 days, for the same amount. */
export function findDuplicatePurchase(
  snapshot: LedgerSnapshot,
  cardId: string,
  totalPaise: number,
  today: string
): Transaction[] {
  const cutoff = new Date(today + "T00:00:00");
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  const byTxn = new Map<string, number>();
  for (const p of snapshot.postings) {
    if (p.account_id !== cardId) continue;
    byTxn.set(p.transaction_id, (byTxn.get(p.transaction_id) ?? 0) + p.amount_paise);
  }
  return snapshot.transactions.filter(
    (t) => t.date >= cutoffISO && byTxn.get(t.id) === -totalPaise
  );
}

export function proposeCardEmi(
  snapshot: LedgerSnapshot,
  input: CardEmiInput,
  mint: MintId = uuid
): Operation {
  const card = snapshot.accounts.find((a) => a.id === input.cardId);
  if (!card) throw new McpError("NOT_FOUND", `No account ${input.cardId} in this book.`);
  if (!isCard(card)) throw new McpError("NOT_FOUND", `${card.name} is not a credit card.`);

  const expense = snapshot.accounts.find((a) => a.id === input.expenseAccountId);
  if (!expense) {
    throw new McpError("NOT_FOUND", `No account ${input.expenseAccountId} in this book.`);
  }
  if (input.months < 1) throw new McpError("UNBALANCED", "An EMI needs at least one installment.");

  const duplicates = findDuplicatePurchase(snapshot, card.id, input.totalPaise, input.today);
  if (duplicates.length > 0 && !input.duplicate) {
    throw new McpError(
      "LIKELY_DUPLICATE",
      `${card.name} already has a ${formatPaise(input.totalPaise)} entry that looks like this ` +
        `purchase. Converting it to an EMI without reversing that entry would count the money ` +
        `twice. Say whether to reverse it or ignore the match.`,
      {
        candidates: duplicates.map((t) => ({ id: t.id, date: t.date, description: t.description })),
      }
    );
  }

  const ops: LedgerOp[] = [];
  const warnings: string[] = [];

  if (input.duplicate === "reverse" && duplicates.length > 0) {
    // reversing rather than deleting: the original spend happened, and the
    // history should say so
    const original = duplicates[0];
    ops.push({
      kind: "entry.create",
      ledgerId: input.ledgerId,
      txn: {
        date: input.today,
        description: `Converted to EMI — ${original.description}`,
        status: "done",
      },
      postings: [
        { account_id: card.id, amount_paise: input.totalPaise },
        { account_id: expense.id, amount_paise: -input.totalPaise },
      ],
    });
  } else if (duplicates.length > 0) {
    warnings.push(
      `A matching ${formatPaise(input.totalPaise)} entry was left in place at your request. ` +
        `If it is the same purchase, this card is now billed for it twice.`
    );
  }

  // the installment: the bank bills the card, the category takes the expense
  const perMonth = Math.round(input.totalPaise / input.months);
  const template: NewTemplate & { id: string } = {
    id: mint(),
    ledger_id: input.ledgerId,
    name: `${input.description} — EMI`,
    kind: "autodebit_cc",
    day_of_month: Number(input.firstBillingISO.slice(8, 10)),
    amount_paise: perMonth,
    from_account_id: card.id,
    to_account_id: expense.id,
    reimburse_account_id: null,
    reimburse_amount_paise: null,
    reimburse_expected_day: null,
    total_installments: input.months,
    installments_done: 0,
    is_budget: false,
    start_date: input.firstBillingISO,
    end_date: null,
    active: true,
    notes: `${formatPaise(input.totalPaise)} over ${input.months} months`,
  };
  ops.push(templateCreateOp(template));

  if (input.processingFeePaise) {
    ops.push({
      kind: "entry.create",
      ledgerId: input.ledgerId,
      txn: {
        date: input.today,
        description: `EMI processing fee — ${input.description}`,
        status: "done",
      },
      postings: [
        { account_id: card.id, amount_paise: -input.processingFeePaise },
        { account_id: expense.id, amount_paise: input.processingFeePaise },
      ],
    });
  }

  if (perMonth * input.months !== input.totalPaise) {
    warnings.push(
      `${formatPaise(input.totalPaise)} does not divide evenly by ${input.months}. ` +
        `The template bills ${formatPaise(perMonth)} a month, ` +
        `${formatPaise(Math.abs(perMonth * input.months - input.totalPaise))} off the total.`
    );
  }

  const balances = computeBalances(snapshot);
  const cycles = computeCardCycles(snapshot, new Date(input.today + "T00:00:00"));
  const cycle = cycles.get(card.id);
  const owed = displayBalance(card, subtreeBalance(snapshot.accounts, balances, card.id));

  const sections: PreviewSection[] = [
    {
      heading: `Each month, from ${input.firstBillingISO}`,
      rows: [
        ["installment", formatPaise(perMonth)],
        ["months", String(input.months)],
        ["billed to", card.name],
        ["category", expense.name],
      ],
    },
    {
      heading: "This card",
      rows: [
        ["cycle cutoff", cycle?.cutoff ?? "—"],
        ["billed now", formatPaise(displayBalance(card, cycle?.billed_paise ?? 0))],
        ["owed today", formatPaise(owed)],
        [
          "limit",
          card.credit_limit_paise ? formatPaise(card.credit_limit_paise) : "not set",
        ],
      ],
    },
  ];

  return {
    ops,
    summary: `Card EMI — ${input.description}, ${input.months} × ${formatPaise(perMonth)}`,
    preview: buildPreview(snapshot, ops, {
      title: `CARD EMI — ${input.description}   ${formatPaise(input.totalPaise)} → ${input.months} × ${formatPaise(perMonth)} on ${card.name}`,
      explanation:
        `${formatPaise(perMonth)} is added to this card's bill on day ${template.day_of_month} ` +
        `for ${input.months} months. It is not a new spend each month — the ` +
        `${formatPaise(input.totalPaise)} purchase is already made; this spreads when the card ` +
        `asks you to pay for it. Today's balance does not move: the first posting is ` +
        `${input.firstBillingISO}.`,
      sections,
      warnings,
    }),
  };
}

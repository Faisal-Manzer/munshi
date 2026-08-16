/**
 * A loan is not one row.
 *
 * It is an account, a disbursal entry, and a repayment template — three
 * writes that only mean something together, which is why they are one
 * proposal and one approval (docs/MCP.md §4.2).
 *
 * Two directions, and they are genuinely different books:
 *   borrowed → a liability that shrinks as you pay it
 *   lent     → a receivable that shrinks as they pay you
 *
 * The honest limit, stated in the preview rather than hidden: the template
 * carries a fixed monthly amount, so the interest/principal split shown in the
 * schedule is informational. Each month posts one EMI-sized leg against the
 * loan account. Booking interest as its own expense is a second template.
 */
import {
  accountCreateOp,
  amortize,
  formatPaise,
  templateCreateOp,
  type LedgerOp,
  type NewAccount,
  type NewTemplate,
} from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { McpError } from "../errors";
import { buildPreview, type PreviewSection } from "../preview";
import { uuid, type MintId, type Operation } from "./types";

export interface LoanInput {
  ledgerId: string;
  direction: "borrowed" | "lent";
  name: string;
  principalPaise: number;
  /** Annual, reducing balance. Zero is allowed — plenty of loans between people are free. */
  ratePercent: number;
  months: number;
  /** The bank/cash account the money arrives in (borrowed) or leaves from (lent). */
  counterAccountId: string;
  firstDueISO: string;
  /** Defaults to today; a loan disbursed last month is a normal thing to record. */
  disbursedISO?: string;
  today: string;
}

/** How many schedule rows a preview shows before it starts wasting the reader's attention. */
const SCHEDULE_PREVIEW_ROWS = 4;

export function proposeLoan(
  snapshot: LedgerSnapshot,
  input: LoanInput,
  mint: MintId = uuid
): Operation {
  const counter = snapshot.accounts.find((a) => a.id === input.counterAccountId);
  if (!counter) {
    throw new McpError("NOT_FOUND", `No account ${input.counterAccountId} in this book.`);
  }
  if (input.principalPaise <= 0) {
    throw new McpError("UNBALANCED", "A loan needs a principal greater than zero.");
  }

  const borrowed = input.direction === "borrowed";
  const schedule = amortize(
    input.principalPaise,
    input.ratePercent,
    input.months,
    input.firstDueISO
  );
  const disbursed = input.disbursedISO ?? input.today;

  const account: NewAccount & { id: string } = {
    id: mint(),
    ledger_id: input.ledgerId,
    name: input.name,
    kind: borrowed ? "liability" : "asset",
    subtype: borrowed ? "loan" : "receivable",
    parent_id: null,
    statement_day: null,
    due_day: Number(input.firstDueISO.slice(8, 10)),
    credit_limit_paise: null,
    person_name: borrowed ? null : input.name,
    reported_balance_paise: null,
    reported_at: null,
    sort_order: 0,
    archived: false,
    is_liquid: false,
  };

  // borrowed: money arrives, the liability grows (credit the loan)
  // lent: money leaves, the receivable grows (debit the person)
  const disbursal: LedgerOp = {
    kind: "entry.create",
    ledgerId: input.ledgerId,
    txn: {
      date: disbursed,
      description: borrowed ? `Loan received — ${input.name}` : `Loan given — ${input.name}`,
      status: "done",
    },
    postings: borrowed
      ? [
          { account_id: counter.id, amount_paise: input.principalPaise },
          { account_id: account.id, amount_paise: -input.principalPaise },
        ]
      : [
          { account_id: account.id, amount_paise: input.principalPaise },
          { account_id: counter.id, amount_paise: -input.principalPaise },
        ],
  };

  const template: NewTemplate & { id: string } = {
    id: mint(),
    ledger_id: input.ledgerId,
    name: `${input.name} — EMI`,
    kind: "autodebit_bank",
    day_of_month: Number(input.firstDueISO.slice(8, 10)),
    amount_paise: schedule.emiPaise,
    // repaying moves money from the cash account into the loan (or from the
    // person back into cash, when they are the ones repaying)
    from_account_id: borrowed ? counter.id : account.id,
    to_account_id: borrowed ? account.id : counter.id,
    reimburse_account_id: null,
    reimburse_amount_paise: null,
    reimburse_expected_day: null,
    total_installments: input.months,
    installments_done: 0,
    is_budget: false,
    start_date: input.firstDueISO,
    end_date: null,
    active: true,
    notes: `${input.ratePercent}% p.a. reducing balance`,
  };

  const ops: LedgerOp[] = [
    accountCreateOp(account),
    disbursal,
    templateCreateOp(template),
  ];

  const head = ["#", "date", "emi", "interest", "principal", "outstanding"];
  const rows = schedule.rows.map((r) => [
    String(r.idx),
    r.dateISO,
    formatPaise(r.emiPaise),
    formatPaise(r.interestPaise),
    formatPaise(r.principalPaise),
    formatPaise(r.outstandingPaise),
  ]);
  const shown =
    rows.length <= SCHEDULE_PREVIEW_ROWS + 1
      ? rows
      : [
          ...rows.slice(0, SCHEDULE_PREVIEW_ROWS),
          ["…", "", "", "", "", ""],
          rows[rows.length - 1],
        ];

  const sections: PreviewSection[] = [
    {
      heading: `Repayment — ${input.months} × ${formatPaise(schedule.emiPaise)} on day ${template.day_of_month}`,
      header: true,
      rows: [head, ...shown],
    },
    {
      heading: "Totals",
      rows: [
        ["principal", formatPaise(input.principalPaise)],
        ["interest", formatPaise(schedule.totalInterestPaise)],
        ["total paid", formatPaise(schedule.totalPaidPaise)],
      ],
    },
  ];

  const last = schedule.rows[schedule.rows.length - 1];
  const explanation = borrowed
    ? `You borrow ${formatPaise(input.principalPaise)}, it lands in ${counter.name}, and ` +
      `${formatPaise(schedule.emiPaise)} leaves that account on day ${template.day_of_month} ` +
      `until ${last.dateISO}. Total interest ${formatPaise(schedule.totalInterestPaise)}.`
    : `You lend ${formatPaise(input.principalPaise)} from ${counter.name}. ${input.name} repays ` +
      `${formatPaise(schedule.emiPaise)} a month until ${last.dateISO}, ` +
      `${formatPaise(schedule.totalInterestPaise)} of it interest.`;

  return {
    ops,
    summary: `${borrowed ? "Loan" : "Loan given"} — ${input.name}, ${formatPaise(input.principalPaise)} × ${input.months}`,
    preview: buildPreview(snapshot, ops, {
      title:
        `LOAN — ${input.name}   ${formatPaise(input.principalPaise)} @ ${input.ratePercent}% p.a. × ${input.months}`,
      explanation,
      sections,
      warnings: [
        `The monthly posting is one ${formatPaise(schedule.emiPaise)} leg against ${input.name}. ` +
          `The interest column above is informational — it is not booked as an expense. ` +
          `Ask for a separate interest template if you want it in the books.`,
      ],
    }),
  };
}

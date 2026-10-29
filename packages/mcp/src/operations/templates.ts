/**
 * Recurring templates: posting this month's occurrence, and changing the plan.
 *
 * Posting a template is what the Book's "post" button does — an entry carrying
 * `recurring_template_id`, which is the only thing that takes the overdue row
 * off the month. An ordinary entry with the same name and amount does not, so
 * posting rent through `propose_entry` would leave rent showing as due and
 * count it twice in the month's outlook. That is why this is its own operation
 * rather than a flag the model has to remember.
 */
import {
  emiInfo,
  entryCreateOp,
  formatPaise,
  templateUpdateOp,
  type LedgerOp,
  type RecurringTemplate,
} from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { McpError } from "../errors";
import { buildPreview } from "../preview";
import type { Operation } from "./types";

export function requireTemplate(snapshot: LedgerSnapshot, id: string): RecurringTemplate {
  const t = snapshot.templates.find((x) => x.id === id);
  if (!t) throw new McpError("NOT_FOUND", `No recurring template ${id} in this book.`);
  return t;
}

/** Entries already posted against a template in the month of `dateISO`. */
export function postedInMonth(snapshot: LedgerSnapshot, templateId: string, dateISO: string) {
  const month = dateISO.slice(0, 7);
  return snapshot.transactions.filter(
    (x) => x.recurring_template_id === templateId && x.date.startsWith(month)
  );
}

/**
 * The person's share of a posted occurrence, the way the Book computes it.
 *
 * A template whose person is also its destination (an EMI run for someone
 * else) is owed in full, whatever the amount. Otherwise the share scales with
 * the amount actually paid, so a bill that came in higher keeps the same split.
 */
export function templateReimburse(t: RecurringTemplate, amountPaise: number): number | null {
  if (!t.reimburse_account_id || !t.reimburse_amount_paise) return null;
  if (t.reimburse_account_id === t.to_account_id) return amountPaise;
  return Math.round((t.reimburse_amount_paise * amountPaise) / t.amount_paise);
}

const nameOf = (snapshot: LedgerSnapshot, id: string | null) =>
  (id && snapshot.accounts.find((a) => a.id === id)?.name) || id || "—";

export interface PostRecurringInput {
  ledgerId: string;
  templateId: string;
  date: string;
  /** What actually went out; defaults to the template's amount. */
  amountPaise?: number | null;
  /** Override the person's share; defaults to the template's, scaled. */
  reimbursePaise?: number | null;
  status?: "pending" | "done";
  tag?: string | null;
  notes?: string | null;
  /** Set when a second occurrence in the same month is genuinely intended. */
  allowDuplicate?: boolean;
}

export function proposePostRecurring(
  snapshot: LedgerSnapshot,
  input: PostRecurringInput
): Operation {
  const t = requireTemplate(snapshot, input.templateId);
  const amountPaise = input.amountPaise ?? t.amount_paise;
  if (amountPaise <= 0) {
    throw new McpError("UNBALANCED", "A posted occurrence needs an amount greater than zero.");
  }

  const already = postedInMonth(snapshot, t.id, input.date);
  if (already.length > 0 && !input.allowDuplicate) {
    throw new McpError(
      "LIKELY_DUPLICATE",
      `"${t.name}" is already posted for ${input.date.slice(0, 7)}. ` +
        `Say so explicitly if this is a second occurrence in the same month.`,
      { candidates: already.map((x) => ({ id: x.id, date: x.date, description: x.description })) }
    );
  }

  const reimbursePaise = input.reimbursePaise ?? templateReimburse(t, amountPaise);
  if (reimbursePaise && reimbursePaise > amountPaise) {
    throw new McpError(
      "UNBALANCED",
      `The person's share (${formatPaise(reimbursePaise)}) is more than the amount ` +
        `(${formatPaise(amountPaise)}).`
    );
  }

  const ops: LedgerOp[] = [
    entryCreateOp({
      ledgerId: input.ledgerId,
      date: input.date,
      description: t.name,
      status: input.status ?? "done",
      fromAccountId: t.from_account_id,
      toAccountId: t.to_account_id,
      amountPaise,
      reimburseAccountId: reimbursePaise ? t.reimburse_account_id : null,
      reimbursePaise: reimbursePaise || null,
      recurringTemplateId: t.id,
      tag: input.tag ?? null,
      notes: input.notes ?? null,
    }),
  ];

  const warnings: string[] = [];
  if (!t.active) warnings.push(`"${t.name}" is marked inactive.`);
  const emi = emiInfo(t, input.date.slice(0, 7));
  if (emi && (emi.idx < 1 || emi.idx > emi.total)) {
    warnings.push(
      `${input.date.slice(0, 7)} is outside this EMI's run (${emi.startISO} to ${emi.endISO}).`
    );
  }
  if (amountPaise !== t.amount_paise) {
    warnings.push(
      `Posting ${formatPaise(amountPaise)} against a template of ${formatPaise(t.amount_paise)}. ` +
        `If the new figure holds for coming months, follow with propose_template_update.`
    );
  }
  if (already.length > 0) warnings.push(`This is a second "${t.name}" in the same month.`);

  const person = reimbursePaise ? nameOf(snapshot, t.reimburse_account_id) : null;
  return {
    ops,
    summary: `Posted recurring — ${t.name} ${formatPaise(amountPaise)}`,
    preview: buildPreview(snapshot, ops, {
      title: `POST RECURRING — ${t.name}${emi ? ` (${emi.idx}/${emi.total})` : ""}   ${formatPaise(amountPaise)}`,
      explanation:
        `${formatPaise(amountPaise)} moves from ${nameOf(snapshot, t.from_account_id)} to ` +
        `${nameOf(snapshot, t.to_account_id)}, linked to the recurring "${t.name}" so the month ` +
        `no longer shows it as due.` +
        (person ? ` ${person} owes ${formatPaise(reimbursePaise!)} of it back.` : ""),
      warnings,
    }),
  };
}

export interface TemplateUpdateInput {
  templateId: string;
  name?: string;
  amountPaise?: number;
  dayOfMonth?: number;
  reimbursePaise?: number | null;
  reimburseExpectedDay?: number | null;
  totalInstallments?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  active?: boolean;
  notes?: string | null;
}

export function proposeTemplateUpdate(
  snapshot: LedgerSnapshot,
  input: TemplateUpdateInput
): Operation {
  const t = requireTemplate(snapshot, input.templateId);
  const patch: Partial<RecurringTemplate> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.amountPaise !== undefined) {
    if (input.amountPaise <= 0) throw new McpError("UNBALANCED", "A template needs an amount above zero.");
    patch.amount_paise = input.amountPaise;
  }
  if (input.dayOfMonth !== undefined) patch.day_of_month = input.dayOfMonth;
  if (input.reimbursePaise !== undefined) patch.reimburse_amount_paise = input.reimbursePaise;
  if (input.reimburseExpectedDay !== undefined) patch.reimburse_expected_day = input.reimburseExpectedDay;
  if (input.totalInstallments !== undefined) patch.total_installments = input.totalInstallments;
  if (input.startDate !== undefined) patch.start_date = input.startDate;
  if (input.endDate !== undefined) patch.end_date = input.endDate;
  if (input.active !== undefined) patch.active = input.active;
  if (input.notes !== undefined) patch.notes = input.notes;

  // someone owed the whole of it stays owed the whole of it
  if (
    patch.amount_paise !== undefined &&
    input.reimbursePaise === undefined &&
    t.reimburse_account_id &&
    t.reimburse_account_id === t.to_account_id &&
    t.reimburse_amount_paise === t.amount_paise
  ) {
    patch.reimburse_amount_paise = patch.amount_paise;
  }

  if (Object.keys(patch).length === 0) {
    throw new McpError("NOT_FOUND", `Nothing to change on "${t.name}".`);
  }
  const reimb = patch.reimburse_amount_paise ?? t.reimburse_amount_paise;
  const amount = patch.amount_paise ?? t.amount_paise;
  if (reimb && reimb > amount) {
    throw new McpError(
      "UNBALANCED",
      `The person's share (${formatPaise(reimb)}) is more than the amount (${formatPaise(amount)}).`
    );
  }

  const show = (k: keyof RecurringTemplate, v: unknown) =>
    v === null || v === undefined
      ? "—"
      : k === "amount_paise" || k === "reimburse_amount_paise"
        ? formatPaise(v as number)
        : String(v);
  const rows = (Object.keys(patch) as (keyof RecurringTemplate)[]).map(
    (k) => [k, `${show(k, t[k])} → ${show(k, patch[k])}`] as [string, string]
  );

  const ops: LedgerOp[] = [templateUpdateOp(t, patch)];
  return {
    ops,
    summary: `Template — ${t.name}`,
    preview: buildPreview(snapshot, ops, {
      title: `UPDATE RECURRING — ${t.name}`,
      explanation:
        `Changes the plan from here on. Entries already posted against "${t.name}" keep the ` +
        `amounts they were posted with; no balance moves today.`,
      sections: [{ heading: "Changes", rows }],
    }),
  };
}

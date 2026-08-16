import { clampDate, toISODate } from "./ledger";
import type { RecurringTemplate } from "./types";

export interface EmiInfo {
  idx: number;    // 1-based installment number in the given month (may be <1 or >total)
  total: number;
  startISO: string; // yyyy-mm-dd of first installment
  endISO: string;   // yyyy-mm-dd of last installment
}

function monthIndex(iso: string): number {
  return Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
}

/** EMI progress for a template in a month ("yyyy-mm"). Null unless both installments and start date are set. */
export function emiInfo(t: RecurringTemplate, monthISO: string): EmiInfo | null {
  if (!t.total_installments || !t.start_date) return null;
  const idx = monthIndex(monthISO) - monthIndex(t.start_date) + 1;
  const s = new Date(t.start_date + "T00:00:00");
  const end = new Date(s.getFullYear(), s.getMonth() + t.total_installments - 1 + 1, 0);
  const endDay = Math.min(s.getDate(), end.getDate());
  const endISO = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
  return { idx, total: t.total_installments, startISO: t.start_date, endISO };
}

/** False when the template is an EMI that hasn't started or has already ended in that month. */
export function emiActive(t: RecurringTemplate, monthISO: string): boolean {
  const e = emiInfo(t, monthISO);
  if (!e) return true;
  return e.idx >= 1 && e.idx <= e.total;
}

export interface AmortRow {
  idx: number;
  dateISO: string;
  emiPaise: number;
  interestPaise: number;
  principalPaise: number;
  outstandingPaise: number;
}

export interface Amortization {
  emiPaise: number;
  rows: AmortRow[];
  totalInterestPaise: number;
  totalPaidPaise: number;
}

/**
 * A reducing-balance loan schedule.
 *
 * Shown in a preview so the user approves a repayment they can see the shape
 * of, not just a monthly figure (docs/MCP.md §4.2). The last installment
 * absorbs the rounding: banks do this too, and it is the only way the
 * outstanding lands exactly on zero rather than a few paise either side.
 *
 * A zero rate is not a special case in the maths but is in the formula, which
 * divides by it — handled explicitly rather than by nudging the rate.
 */
export function amortize(
  principalPaise: number,
  annualRatePercent: number,
  months: number,
  firstDueISO: string
): Amortization {
  if (months < 1) throw new Error("A loan needs at least one installment.");
  const r = annualRatePercent / 12 / 100;
  const emi =
    r === 0
      ? Math.round(principalPaise / months)
      : Math.round(
          (principalPaise * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1)
        );

  const rows: AmortRow[] = [];
  let outstanding = principalPaise;
  const first = new Date(firstDueISO + "T00:00:00");

  for (let i = 1; i <= months; i++) {
    const interest = Math.round(outstanding * r);
    const last = i === months;
    // the final payment is whatever clears the balance, rounding included
    const emiThis = last ? outstanding + interest : emi;
    const principal = emiThis - interest;
    outstanding -= principal;
    const due = clampDate(first.getFullYear(), first.getMonth() + i - 1, first.getDate());
    rows.push({
      idx: i,
      dateISO: toISODate(due),
      emiPaise: emiThis,
      interestPaise: interest,
      principalPaise: principal,
      outstandingPaise: outstanding,
    });
  }

  return {
    emiPaise: emi,
    rows,
    totalInterestPaise: rows.reduce((s, x) => s + x.interestPaise, 0),
    totalPaidPaise: rows.reduce((s, x) => s + x.emiPaise, 0),
  };
}

export function fmtMonth(iso: string): string {
  return new Date(iso.slice(0, 7) + "-01T00:00:00").toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
  });
}

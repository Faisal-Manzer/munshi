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

export function fmtMonth(iso: string): string {
  return new Date(iso.slice(0, 7) + "-01T00:00:00").toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
  });
}

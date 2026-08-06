/**
 * Amount search: "520.65" matches exactly; an integer matches by precision —
 * trailing zeros widen the bucket (520 hits 520.xx, 500 hits 5xx.xx).
 * Commas, spaces, and ₹ are ignored.
 */
export function amountMatches(qRaw: string, paise: number): boolean {
  const cleaned = qRaw.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return false;
  const abs = Math.abs(paise);
  if (cleaned.includes(".")) return abs === Math.round(Number(cleaned) * 100);
  const zeros = /0*$/.exec(cleaned)![0].length;
  const unit = Math.pow(10, zeros) * 100; // paise per bucket
  return Math.floor(abs / unit) === Math.floor((Number(cleaned) * 100) / unit);
}

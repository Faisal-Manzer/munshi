// Amounts stored as integer paise. Display in ₹ with Indian digit grouping.

// spreadsheet style: every amount shows exactly two decimals — ₹15,000.00
const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const plain = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPaise(paise: number): string {
  return inr.format(paise === 0 ? 0 : paise / 100); // paise===0 avoids "-₹0.00"
}

export function formatPaisePlain(paise: number): string {
  return plain.format(paise === 0 ? 0 : paise / 100);
}

/** Parse a user-typed rupee amount ("17,099" / "17099.50") into paise. */
export function parseRupees(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

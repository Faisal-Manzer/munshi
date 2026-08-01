// Amounts stored as integer paise. Display in ₹ with Indian digit grouping.

// whole rupees show no decimals; anything fractional always shows two (₹8,549.50, never ₹8,549.5)
const inrWhole = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const inrFrac = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const plainWhole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const plainFrac = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPaise(paise: number): string {
  const v = paise === 0 ? 0 : paise / 100; // avoid "-₹0"
  return (Number.isInteger(v) ? inrWhole : inrFrac).format(v);
}

export function formatPaisePlain(paise: number): string {
  const v = paise === 0 ? 0 : paise / 100;
  return (Number.isInteger(v) ? plainWhole : plainFrac).format(v);
}

/** Parse a user-typed rupee amount ("17,099" / "17099.50") into paise. */
export function parseRupees(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

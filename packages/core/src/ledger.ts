import type { Account, AccountBalance } from "./types";

/**
 * Ledger convention: postings are debit + / credit -.
 * Assets & expenses carry natural debit (positive) balances.
 * Liabilities & income carry natural credit (negative) balances.
 * displayBalance flips liability/income so "amount owed" / "amount earned" read positive.
 */
export function displayBalance(account: Account, rawPaise: number): number {
  return account.kind === "liability" || account.kind === "income"
    ? -rawPaise
    : rawPaise;
}

export function childrenOf(accounts: Account[], parentId: string): Account[] {
  return accounts.filter((a) => a.parent_id === parentId && !a.archived);
}

/** Balance of an account including all descendants (envelopes, sub-cards). */
export function subtreeBalance(
  accounts: Account[],
  balances: Map<string, AccountBalance>,
  accountId: string,
  field: "balance_paise" | "settled_paise" | "pending_paise" = "balance_paise"
): number {
  let total = balances.get(accountId)?.[field] ?? 0;
  for (const child of accounts.filter((a) => a.parent_id === accountId)) {
    total += subtreeBalance(accounts, balances, child.id, field);
  }
  return total;
}

/** For a bank with envelopes: available = own balance minus nothing; envelopes hold their own money. */
export function availableBalance(
  accounts: Account[],
  balances: Map<string, AccountBalance>,
  bankId: string
): { total: number; setAside: number; available: number } {
  const total = subtreeBalance(accounts, balances, bankId);
  const own = balances.get(bankId)?.balance_paise ?? 0;
  return { total, setAside: total - own, available: own };
}

export function isCard(a: Account): boolean {
  return a.subtype === "credit_card";
}

export function isParentCard(accounts: Account[], a: Account): boolean {
  return isCard(a) && a.parent_id === null;
}

/** Next occurrence of a day-of-month on/after `from`. Clamps day 29-31 to month end. */
export function nextOccurrence(dayOfMonth: number, from: Date): Date {
  const clamp = (y: number, m: number) => {
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(dayOfMonth, last));
  };
  const thisMonth = clamp(from.getFullYear(), from.getMonth());
  if (thisMonth >= stripTime(from)) return thisMonth;
  return clamp(from.getFullYear(), from.getMonth() + 1);
}

/** Last day of the month clamps days 29–31 in short months. */
export function clampDate(y: number, m: number, day: number): Date {
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, last));
}

export function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

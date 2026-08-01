// The shared calculation brain: template classification, card-cycle
// projection and per-month plan math. Pure functions — the Book and Plan
// pages both call these so the two screens can never disagree.

import { emiActive } from "./emi";
import { toISODate } from "./ledger";
import type {
  Account,
  AccountBalance,
  CardCycle,
  Posting,
  RecurringTemplate,
  Transaction,
} from "./types";

export type Txn = Transaction & { postings: Posting[] };

export function accountById(accounts: Account[], id: string | null) {
  return accounts.find((a) => a.id === id);
}

/** Last day of the month clamps days 29–31 in short months. */
export function clampDate(y: number, m: number, day: number): Date {
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, last));
}

// ---- template classification ------------------------------------------------

export function isIncomeTemplate(accounts: Account[], t: RecurringTemplate): boolean {
  return accountById(accounts, t.from_account_id)?.kind === "income";
}

/** Asset→asset move that isn't a budget and doesn't touch a person — excluded from committed spend. */
export function isInternalTemplate(accounts: Account[], t: RecurringTemplate): boolean {
  if (t.is_budget) return false;
  const from = accountById(accounts, t.from_account_id);
  const to = accountById(accounts, t.to_account_id);
  return from?.kind === "asset" && to?.kind === "asset" && to?.subtype !== "receivable";
}

// ---- one-off (pending txn) classification -----------------------------------

export type OneOffKind = "in" | "out" | "back" | "card" | "internal";

export function oneOffKind(accounts: Account[], x: Txn): OneOffKind {
  const neg = x.postings.find((p) => p.amount_paise < 0);
  const pos = x.postings.find(
    (p) => p.amount_paise > 0 && p.account_id !== x.reimburse_account_id
  );
  const from = neg ? accountById(accounts, neg.account_id) : undefined;
  const to = pos ? accountById(accounts, pos.account_id) : undefined;
  if (from?.kind === "income") return "in";
  if (from?.subtype === "receivable") return "back";
  if (from?.subtype === "credit_card") return "card";
  if (to?.kind === "asset" && to?.subtype !== "receivable") return "internal";
  return "out";
}

export function oneOffAmount(x: Txn): number {
  const neg = x.postings.find((p) => p.amount_paise < 0);
  return neg ? -neg.amount_paise : 0;
}

// ---- card subtree + current cycle -------------------------------------------

export function parentCardsOf(active: Account[]): Account[] {
  return active.filter((a) => a.subtype === "credit_card" && a.parent_id === null);
}

export function subtreeIds(active: Account[], card: Account): string[] {
  return [card.id, ...active.filter((a) => a.parent_id === card.id).map((a) => a.id)];
}

/** What the last statement still needs, card + sub-cards, floored at zero. */
export function cardDueNow(
  active: Account[],
  cycles: Map<string, CardCycle>,
  card: Account
): number {
  let billed = 0,
    paid = 0;
  for (const c of [card, ...active.filter((a) => a.parent_id === card.id)]) {
    const cy = cycles.get(c.id);
    if (!cy) continue;
    billed += -cy.billed_paise;
    paid += cy.payments_since_paise;
  }
  return Math.max(0, billed - paid);
}

/** Swipes since the last statement — they'll be on the next bill. */
export function cardUnbilled(
  active: Account[],
  cycles: Map<string, CardCycle>,
  card: Account
): number {
  return [card, ...active.filter((a) => a.parent_id === card.id)].reduce(
    (s, c) => s + -(cycles.get(c.id)?.spends_since_paise ?? 0),
    0
  );
}

// ---- plan-month math ---------------------------------------------------------

export interface PlanContext {
  accounts: Account[];
  active: Account[];
  templates: RecurringTemplate[];
  allOneOffs: Txn[];
  cycles: Map<string, CardCycle>;
  today: Date;
}

export interface CardPlan {
  card: Account;
  dueDate: Date;
  stmtDate: Date;
  unbilledNow: number; // real swipes already in the cycle window
  recurring: number; // card-charged templates still to land before the statement
  planned: number; // one-off pending card txns inside the window
  total: number;
  estimateOnly: boolean; // window too far out — recurring only
}

export function oneOffsFor(allOneOffs: Txn[], m: string): Txn[] {
  return allOneOffs.filter((x) => x.date.slice(0, 7) === m);
}

/** Per card: the statement whose DUE date lands in plan month `m`, and its projected bill. */
export function cardPlansFor(ctx: PlanContext, m: string): CardPlan[] {
  const { active, cycles, templates, allOneOffs, today } = ctx;
  // months between now and the plan month — the due-landing statement is
  // within ±2 of that, however far out the plan month is
  const ahead =
    Number(m.slice(0, 4)) * 12 +
    Number(m.slice(5, 7)) -
    1 -
    (today.getFullYear() * 12 + today.getMonth());
  return parentCardsOf(active).flatMap((card) => {
    const s = card.statement_day,
      dd = card.due_day;
    if (!s || !dd) return [];
    // find the statement whose DUE lands in the plan month
    for (let k = Math.max(0, ahead - 2); k <= ahead + 2; k++) {
      const st = clampDate(today.getFullYear(), today.getMonth() + k, s);
      const due =
        dd > s
          ? clampDate(st.getFullYear(), st.getMonth(), dd)
          : clampDate(st.getFullYear(), st.getMonth() + 1, dd);
      if (toISODate(due).slice(0, 7) !== m) continue;
      const windowStart = clampDate(st.getFullYear(), st.getMonth() - 1, s);
      const ids = subtreeIds(active, card);
      // real spends already made inside this window (cycle view counts since last cutoff)
      const windowOpen = windowStart <= today && today < st;
      const unbilledNow = windowOpen
        ? ids.reduce((sum, id) => sum + -(cycles.get(id)?.spends_since_paise ?? 0), 0)
        : 0;
      // card-charged recurrings landing after today, on or before the statement
      const recurring = templates
        .filter((t) => ids.includes(t.from_account_id))
        .reduce((sum, t) => {
          for (let j = 0; j <= k + 1; j++) {
            const occ = clampDate(today.getFullYear(), today.getMonth() + j, t.day_of_month);
            if (occ > today && occ > windowStart && occ <= st) {
              // an EMI only charges the card while its window covers the occurrence
              return emiActive(t, toISODate(occ).slice(0, 7)) ? sum + t.amount_paise : sum;
            }
          }
          return sum;
        }, 0);
      // planned one-off card swipes dated inside the window
      const planned = allOneOffs
        .filter((x) => {
          const neg = x.postings.find((p) => p.amount_paise < 0);
          if (!neg || !ids.includes(neg.account_id)) return false;
          const d = new Date(x.date + "T00:00:00");
          return d > windowStart && d <= st;
        })
        .reduce((sum, x) => sum + oneOffAmount(x), 0);
      const estimateOnly = !windowOpen && windowStart > today;
      return [
        {
          card,
          dueDate: due,
          stmtDate: st,
          unbilledNow,
          recurring,
          planned,
          total: unbilledNow + recurring + planned,
          estimateOnly,
        },
      ];
    }
    return [];
  });
}

export interface MonthPlan {
  plannedIn: number;
  committed: number;
  expectedBack: number;
  cardPlans: CardPlan[];
  cardDue: number;
  left: number;
}

export function monthPlan(ctx: PlanContext, m: string): MonthPlan {
  const { accounts, templates, allOneOffs } = ctx;
  const offs = oneOffsFor(allOneOffs, m);
  const offIn = offs
    .filter((x) => oneOffKind(accounts, x) === "in")
    .reduce((s, x) => s + oneOffAmount(x), 0);
  const offOut = offs
    .filter((x) => oneOffKind(accounts, x) === "out")
    .reduce((s, x) => s + oneOffAmount(x), 0);
  const offBack = offs
    .filter((x) => oneOffKind(accounts, x) === "back")
    .reduce((s, x) => s + oneOffAmount(x), 0);
  // fixed monthly plan (budgets + salary are the same every month);
  // EMIs count only while their window covers the plan month
  const tpl = templates.filter((t) => emiActive(t, m));
  const plannedIn =
    tpl.filter((t) => isIncomeTemplate(accounts, t)).reduce((s, t) => s + t.amount_paise, 0) +
    offIn;
  const committed =
    tpl
      .filter((t) => {
        if (isIncomeTemplate(accounts, t) || isInternalTemplate(accounts, t)) return false;
        return accountById(accounts, t.from_account_id)?.subtype !== "credit_card";
      })
      .reduce((s, t) => s + t.amount_paise, 0) + offOut;
  const expectedBack =
    tpl.reduce((s, t) => s + (t.reimburse_amount_paise ?? 0), 0) + offBack;
  const cardPlans = cardPlansFor(ctx, m);
  const cardDue = cardPlans.reduce((s, c) => s + c.total, 0);
  return {
    plannedIn,
    committed,
    expectedBack,
    cardPlans,
    cardDue,
    left: plannedIn - committed - cardDue + expectedBack,
  };
}

/** Sum of is_liquid account balances. */
export function liquidNowOf(
  active: Account[],
  balances: Map<string, AccountBalance>
): number {
  return active
    .filter((a) => a.is_liquid)
    .reduce((s, a) => s + (balances.get(a.id)?.balance_paise ?? 0), 0);
}

/** Liquid today + every month's `left` from nextMonth through the viewed month. */
export function projectedLiquidThrough(
  ctx: PlanContext,
  liquidNow: number,
  nextMonth: string,
  month: string
): number {
  let projected = liquidNow;
  let m = nextMonth;
  while (m <= month) {
    projected += monthPlan(ctx, m).left;
    const [y, mo] = m.split("-").map(Number);
    m = toISODate(new Date(y, mo, 1)).slice(0, 7);
  }
  return projected;
}

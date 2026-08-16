import { describe, expect, it } from "vitest";
import {
  accountById,
  cardDueNow,
  liquidOutlook,
  monthActuals,
  cardPlansFor,
  cardUnbilled,
  clampDate,
  isIncomeTemplate,
  isInternalTemplate,
  liquidNowOf,
  monthPlan,
  oneOffAmount,
  oneOffKind,
  oneOffsFor,
  parentCardsOf,
  projectedLiquidThrough,
  subtreeIds,
  type PlanContext,
  type Txn,
} from "@munshi/core";
import { toISODate } from "@munshi/core";
import type {
  Account,
  AccountBalance,
  CardCycle,
  RecurringTemplate,
} from "@munshi/core";

// ---- fixtures ---------------------------------------------------------------

function acc(patch: Partial<Account> & { id: string }): Account {
  return {
    user_id: "u1",
    ledger_id: "l1",
    name: patch.id,
    kind: "asset",
    subtype: "bank",
    parent_id: null,
    statement_day: null,
    due_day: null,
    credit_limit_paise: null,
    person_name: null,
    reported_balance_paise: null,
    reported_at: null,
    sort_order: 0,
    archived: false,
    is_liquid: false,
    ...patch,
  };
}

function tpl(patch: Partial<RecurringTemplate> & { id: string }): RecurringTemplate {
  return {
    ledger_id: "l1",
    name: patch.id,
    kind: "autodebit_bank",
    day_of_month: 5,
    amount_paise: 0,
    from_account_id: "bank",
    to_account_id: "expense",
    reimburse_account_id: null,
    reimburse_amount_paise: null,
    reimburse_expected_day: null,
    total_installments: null,
    installments_done: 0,
    is_budget: false,
    start_date: null,
    end_date: null,
    active: true,
    notes: null,
    ...patch,
  };
}

let txnSeq = 0;
function txn(
  date: string,
  legs: [accountId: string, paise: number][],
  patch: Partial<Txn> = {}
): Txn {
  const id = `x${++txnSeq}`;
  return {
    id,
    ledger_id: "l1",
    date,
    description: id,
    status: "pending",
    tag: null,
    recurring_template_id: null,
    reimburse_account_id: null,
    reimburse_amount_paise: null,
    notes: null,
    postings: legs.map(([account_id, amount_paise], i) => ({
      id: `${id}p${i}`,
      transaction_id: id,
      account_id,
      amount_paise,
    })),
    ...patch,
  };
}

const salary = acc({ id: "salary", kind: "income", subtype: "salary" });
const bank = acc({ id: "bank", is_liquid: true });
const bank2 = acc({ id: "bank2" }); // not liquid
const envelope = acc({ id: "envelope", subtype: "envelope", parent_id: "bank", is_liquid: true });
const cash = acc({ id: "cash", subtype: "cash", is_liquid: true });
const investment = acc({ id: "investment", subtype: "investment" });
const card = acc({
  id: "card",
  kind: "liability",
  subtype: "credit_card",
  statement_day: 27,
  due_day: 15, // due < statement day → due lands the month AFTER the statement
});
const subcard = acc({
  id: "subcard",
  kind: "liability",
  subtype: "credit_card",
  parent_id: "card",
});
const card2 = acc({
  id: "card2",
  kind: "liability",
  subtype: "credit_card",
  statement_day: 5,
  due_day: 20, // due > statement day → due lands the SAME month as the statement
});
const person = acc({ id: "person", subtype: "receivable" });
const expense = acc({ id: "expense", kind: "expense", subtype: "general_expense" });

const accounts = [
  salary, bank, bank2, envelope, cash, investment, card, subcard, card2, person, expense,
];

const salaryT = tpl({ id: "salaryT", from_account_id: "salary", to_account_id: "bank", amount_paise: 100000, day_of_month: 1 });
const rentT = tpl({ id: "rentT", from_account_id: "bank", to_account_id: "expense", amount_paise: 30000, day_of_month: 3 });
const budgetT = tpl({ id: "budgetT", from_account_id: "bank", to_account_id: "bank2", amount_paise: 15000, is_budget: true });
const internalT = tpl({ id: "internalT", from_account_id: "bank", to_account_id: "investment", amount_paise: 5000 });
const reimburseT = tpl({
  id: "reimburseT", from_account_id: "bank", to_account_id: "expense",
  amount_paise: 17000, reimburse_account_id: "person", reimburse_amount_paise: 8500,
});
// EMI on the card: 12 installments Oct 2025 → Sep 2026
const cardEmiT = tpl({
  id: "cardEmiT", from_account_id: "card", to_account_id: "expense",
  amount_paise: 20000, day_of_month: 5, total_installments: 12, start_date: "2025-10-05",
});
const subcardT = tpl({ id: "subcardT", from_account_id: "subcard", to_account_id: "expense", amount_paise: 7000, day_of_month: 10 });

const templates = [salaryT, rentT, budgetT, internalT, reimburseT, cardEmiT, subcardT];

const cycles = new Map<string, CardCycle>([
  ["card", { account_id: "card", cutoff: "2026-07-27", billed_paise: -50000, payments_since_paise: 20000, spends_since_paise: -12000 }],
  ["subcard", { account_id: "subcard", cutoff: "2026-07-27", billed_paise: -10000, payments_since_paise: 0, spends_since_paise: -3000 }],
]);

const TODAY = new Date(2026, 7, 1); // 01 Aug 2026

function ctxWith(allOneOffs: Txn[] = [], tplOverride?: RecurringTemplate[]): PlanContext {
  return {
    accounts,
    active: accounts,
    templates: tplOverride ?? templates,
    allOneOffs,
    cycles,
    today: TODAY,
  };
}

// ---- basic helpers ----------------------------------------------------------

describe("accountById", () => {
  it("finds by id and returns undefined for null/missing", () => {
    expect(accountById(accounts, "bank")?.id).toBe("bank");
    expect(accountById(accounts, null)).toBeUndefined();
    expect(accountById(accounts, "nope")).toBeUndefined();
  });
});

describe("clampDate", () => {
  it("keeps valid days", () => {
    expect(toISODate(clampDate(2026, 0, 15))).toBe("2026-01-15");
  });
  it("clamps 29–31 to the month end", () => {
    expect(toISODate(clampDate(2026, 1, 31))).toBe("2026-02-28");
    expect(toISODate(clampDate(2024, 1, 31))).toBe("2024-02-29"); // leap
    expect(toISODate(clampDate(2026, 3, 31))).toBe("2026-04-30");
  });
  it("normalises month overflow (month 12 = January next year)", () => {
    expect(toISODate(clampDate(2026, 12, 5))).toBe("2027-01-05");
  });
});

// ---- classification ---------------------------------------------------------

describe("isIncomeTemplate", () => {
  it("is true only when money comes from an income account", () => {
    expect(isIncomeTemplate(accounts, salaryT)).toBe(true);
    expect(isIncomeTemplate(accounts, rentT)).toBe(false);
    expect(isIncomeTemplate(accounts, cardEmiT)).toBe(false);
  });
});

describe("isInternalTemplate", () => {
  it("asset→asset transfer is internal", () => {
    expect(isInternalTemplate(accounts, internalT)).toBe(true);
  });
  it("the budget flag turns a transfer into committed spend", () => {
    expect(isInternalTemplate(accounts, budgetT)).toBe(false);
  });
  it("a transfer to a person is NOT internal (it's lending)", () => {
    const lendT = tpl({ id: "lendT", from_account_id: "bank", to_account_id: "person", amount_paise: 1000 });
    expect(isInternalTemplate(accounts, lendT)).toBe(false);
  });
  it("expense and income templates are not internal", () => {
    expect(isInternalTemplate(accounts, rentT)).toBe(false);
    expect(isInternalTemplate(accounts, salaryT)).toBe(false);
  });
});

describe("oneOffKind / oneOffAmount", () => {
  it("classifies income, spend, repayment, card swipe and internal moves", () => {
    expect(oneOffKind(accounts, txn("2026-09-01", [["salary", -25000], ["bank", 25000]]))).toBe("in");
    expect(oneOffKind(accounts, txn("2026-09-05", [["bank", -6000], ["expense", 6000]]))).toBe("out");
    expect(oneOffKind(accounts, txn("2026-09-06", [["person", -2000], ["bank", 2000]]))).toBe("back");
    expect(oneOffKind(accounts, txn("2026-09-10", [["card", -9000], ["expense", 9000]]))).toBe("card");
    expect(oneOffKind(accounts, txn("2026-09-12", [["bank", -3000], ["bank2", 3000]]))).toBe("internal");
  });

  it("a transfer to a person counts as a spend (lending), not internal", () => {
    expect(oneOffKind(accounts, txn("2026-09-12", [["bank", -3000], ["person", 3000]]))).toBe("out");
  });

  it("ignores the reimbursement leg when finding the destination", () => {
    const split = txn(
      "2026-09-05",
      [["bank", -10000], ["expense", 6000], ["person", 4000]],
      { reimburse_account_id: "person", reimburse_amount_paise: 4000 }
    );
    expect(oneOffKind(accounts, split)).toBe("out");
  });

  it("amount is the credited leg, zero when there is none", () => {
    expect(oneOffAmount(txn("2026-09-05", [["bank", -6000], ["expense", 6000]]))).toBe(6000);
    expect(oneOffAmount(txn("2026-09-05", []))).toBe(0);
  });
});

// ---- card subtree + current cycle -------------------------------------------

describe("parentCardsOf / subtreeIds", () => {
  it("parent cards are cards without a parent", () => {
    expect(parentCardsOf(accounts).map((c) => c.id).sort()).toEqual(["card", "card2"]);
  });
  it("subtree = card + its sub-cards", () => {
    expect(subtreeIds(accounts, card).sort()).toEqual(["card", "subcard"]);
    expect(subtreeIds(accounts, card2)).toEqual(["card2"]);
  });
});

describe("cardDueNow", () => {
  it("folds sub-cards into the parent and nets payments", () => {
    // billed 50000+10000, paid 20000 → 40000 still due
    expect(cardDueNow(accounts, cycles, card)).toBe(40000);
  });
  it("floors at zero when overpaid", () => {
    const over = new Map<string, CardCycle>([
      ["card2", { account_id: "card2", cutoff: "2026-08-05", billed_paise: -5000, payments_since_paise: 9000, spends_since_paise: 0 }],
    ]);
    expect(cardDueNow(accounts, over, card2)).toBe(0);
  });
  it("is zero without cycle data", () => {
    expect(cardDueNow(accounts, new Map(), card)).toBe(0);
  });
});

describe("cardUnbilled", () => {
  it("sums unbilled swipes across the subtree", () => {
    expect(cardUnbilled(accounts, cycles, card)).toBe(15000); // 12000 + 3000
  });
  it("is zero without cycle data", () => {
    expect(cardUnbilled(accounts, new Map(), card)).toBe(0);
  });
});

// ---- card plan projection ---------------------------------------------------

describe("cardPlansFor", () => {
  it("finds the statement whose due date lands in the plan month (due after statement month)", () => {
    // card: bills 27 Aug, due 15 Sep
    const plans = cardPlansFor(ctxWith(), "2026-09");
    const p = plans.find((c) => c.card.id === "card")!;
    expect(toISODate(p.stmtDate)).toBe("2026-08-27");
    expect(toISODate(p.dueDate)).toBe("2026-09-15");
  });

  it("handles due day > statement day (same-month due)", () => {
    // card2: bills 5 Sep, due 20 Sep
    const plans = cardPlansFor(ctxWith(), "2026-09");
    const p = plans.find((c) => c.card.id === "card2")!;
    expect(toISODate(p.stmtDate)).toBe("2026-09-05");
    expect(toISODate(p.dueDate)).toBe("2026-09-20");
    // its window (5 Aug – 5 Sep] hasn't opened on 1 Aug → estimate only
    expect(p.estimateOnly).toBe(true);
    expect(p.unbilledNow).toBe(0);
  });

  it("counts live unbilled swipes when the cycle window is open", () => {
    const p = cardPlansFor(ctxWith(), "2026-09").find((c) => c.card.id === "card")!;
    expect(p.estimateOnly).toBe(false);
    expect(p.unbilledNow).toBe(15000); // card 12000 + subcard 3000
  });

  it("projects card-charged recurrings (incl. sub-card) landing inside the window", () => {
    const p = cardPlansFor(ctxWith(), "2026-09").find((c) => c.card.id === "card")!;
    // EMI 20000 on 5 Aug + subcard 7000 on 10 Aug, both in (27 Jul – 27 Aug]
    expect(p.recurring).toBe(27000);
  });

  it("adds planned one-off card swipes dated inside the window", () => {
    const inWindow = txn("2026-08-20", [["card", -4000], ["expense", 4000]]);
    const outsideWindow = txn("2026-09-10", [["card", -9000], ["expense", 9000]]);
    const p = cardPlansFor(ctxWith([inWindow, outsideWindow]), "2026-09")
      .find((c) => c.card.id === "card")!;
    expect(p.planned).toBe(4000);
    expect(p.total).toBe(15000 + 27000 + 4000);
  });

  it("a swipe during the plan month bills the month after (carry-over)", () => {
    const sepSwipe = txn("2026-09-10", [["card", -9000], ["expense", 9000]]);
    const oct = cardPlansFor(ctxWith([sepSwipe]), "2026-10").find((c) => c.card.id === "card")!;
    expect(oct.planned).toBe(9000);
  });

  it("still charges an EMI's last installment into the following month's due", () => {
    // 12th installment hits 5 Sep → bills 27 Sep → due 15 Oct
    const oct = cardPlansFor(ctxWith(), "2026-10").find((c) => c.card.id === "card")!;
    expect(oct.recurring).toBe(20000 + 7000);
    expect(oct.estimateOnly).toBe(true); // window opens 27 Aug, today is 1 Aug
    expect(oct.unbilledNow).toBe(0);
  });

  it("drops an ended EMI from later cycles", () => {
    // EMI ends Sep 2026 — its 5 Oct occurrence must not charge Nov's due
    const nov = cardPlansFor(ctxWith(), "2026-11").find((c) => c.card.id === "card")!;
    expect(nov.recurring).toBe(7000); // subcard template only
  });

  it("works arbitrarily far in the future", () => {
    const far = cardPlansFor(ctxWith(), "2028-03").find((c) => c.card.id === "card")!;
    expect(toISODate(far.stmtDate)).toBe("2028-02-27");
    expect(toISODate(far.dueDate)).toBe("2028-03-15");
    expect(far.estimateOnly).toBe(true);
    expect(far.recurring).toBe(7000); // only the open-ended subcard template
  });

  // Axis-style card: bills the 11th, due the 1st of the next month
  const axis = acc({ id: "axis", kind: "liability", subtype: "credit_card", statement_day: 11, due_day: 1 });
  function axisCtx(payments = 0): PlanContext {
    return {
      accounts: [...accounts, axis],
      active: [...accounts, axis],
      templates: [],
      allOneOffs: [],
      cycles: new Map([
        ["axis", { account_id: "axis", cutoff: "2026-08-11", billed_paise: -1002756, payments_since_paise: payments, spends_since_paise: -5000 }],
      ]),
      today: new Date(2026, 7, 17), // 17 Aug — the 11 Aug statement has cut
    };
  }

  it("carries the real unpaid bill once the statement has cut", () => {
    const p = cardPlansFor(axisCtx(), "2026-09").find((c) => c.card.id === "axis")!;
    expect(toISODate(p.stmtDate)).toBe("2026-08-11");
    expect(toISODate(p.dueDate)).toBe("2026-09-01");
    expect(p.alreadyBilled).toBe(true);
    expect(p.total).toBe(1002756);
  });

  it("payments since the cutoff shrink an already-billed due", () => {
    const p = cardPlansFor(axisCtx(1002756), "2026-09").find((c) => c.card.id === "axis")!;
    expect(p.alreadyBilled).toBe(true);
    expect(p.total).toBe(0);
  });

  it("skips cards without statement/due days", () => {
    const bare = acc({ id: "bare", kind: "liability", subtype: "credit_card" });
    const ctx = { ...ctxWith(), active: [...accounts, bare] };
    expect(cardPlansFor(ctx, "2026-09").some((c) => c.card.id === "bare")).toBe(false);
  });
});

// ---- month plan -------------------------------------------------------------

describe("monthPlan", () => {
  it("computes the full September plan from templates alone", () => {
    const p = monthPlan(ctxWith(), "2026-09");
    expect(p.plannedIn).toBe(100000); // salary
    // rent 30000 + budget 15000 + reimburse 17000; card-charged and internal excluded
    expect(p.committed).toBe(62000);
    expect(p.expectedBack).toBe(8500);
    // card: 15000 unbilled + 27000 recurring; card2: 0
    expect(p.cardDue).toBe(42000);
    expect(p.left).toBe(100000 - 62000 - 42000 + 8500);
  });

  it("folds one-offs into the right buckets", () => {
    const offs = [
      txn("2026-09-01", [["salary", -25000], ["bank", 25000]]), // in
      txn("2026-09-05", [["bank", -6000], ["expense", 6000]]), // out
      txn("2026-09-06", [["person", -2000], ["bank", 2000]]), // back
      txn("2026-09-12", [["bank", -3000], ["bank2", 3000]]), // internal — ignored
      txn("2026-09-10", [["card", -9000], ["expense", 9000]]), // card — not cash committed
    ] as Txn[];
    const p = monthPlan(ctxWith(offs), "2026-09");
    expect(p.plannedIn).toBe(125000);
    expect(p.committed).toBe(68000);
    expect(p.expectedBack).toBe(10500);
    expect(p.cardDue).toBe(42000); // Sep-dated swipe bills in Oct, not Sep
  });

  it("only counts one-offs dated in the plan month", () => {
    const offs = [txn("2026-10-05", [["bank", -6000], ["expense", 6000]])];
    expect(monthPlan(ctxWith(offs), "2026-09").committed).toBe(62000);
    expect(monthPlan(ctxWith(offs), "2026-10").committed).toBe(62000 + 6000);
  });

  it("drops an EMI (and its reimbursement) outside its window", () => {
    const emiWithBack = tpl({
      id: "e", from_account_id: "bank", to_account_id: "expense", amount_paise: 17000,
      reimburse_account_id: "person", reimburse_amount_paise: 8500,
      total_installments: 2, start_date: "2026-08-05",
    });
    const ctx = ctxWith([], [emiWithBack]);
    expect(monthPlan(ctx, "2026-09")).toMatchObject({ committed: 17000, expectedBack: 8500 });
    expect(monthPlan(ctx, "2026-10")).toMatchObject({ committed: 0, expectedBack: 0 });
  });
});

// ---- liquidity + projection -------------------------------------------------

function balances(entries: [string, number][]): Map<string, AccountBalance> {
  return new Map(entries.map(([id, b]) => [
    id, { account_id: id, balance_paise: b, settled_paise: b, pending_paise: 0 },
  ]));
}

describe("liquidNowOf", () => {
  it("sums only is_liquid accounts", () => {
    const b = balances([
      ["bank", 50000], ["envelope", 10000], ["cash", 5000],
      ["bank2", 99999], ["investment", 88888], ["card", -12345],
    ]);
    expect(liquidNowOf(accounts, b)).toBe(65000);
  });
});

describe("projectedLiquidThrough", () => {
  // simple world: salary 100000 in, rent 30000 out, no cards → left = 70000/month
  const simpleCtx: PlanContext = {
    accounts, active: [salary, bank, expense], templates: [salaryT, rentT],
    allOneOffs: [], cycles: new Map(), today: TODAY,
  };

  it("accumulates every month's left through the viewed month", () => {
    expect(projectedLiquidThrough(simpleCtx, 50000, "2026-09", "2026-09")).toBe(120000);
    expect(projectedLiquidThrough(simpleCtx, 50000, "2026-09", "2026-11")).toBe(260000);
  });

  it("crosses year boundaries", () => {
    // Sep 2026 – Feb 2027 = 6 months
    expect(projectedLiquidThrough(simpleCtx, 0, "2026-09", "2027-02")).toBe(420000);
  });

  it("returns liquidNow untouched when the viewed month is before the start", () => {
    expect(projectedLiquidThrough(simpleCtx, 50000, "2026-09", "2026-08")).toBe(50000);
  });
});

// ---- book-month actuals ------------------------------------------------------

describe("monthActuals", () => {
  const done = { status: "done" as const };

  it("buckets done txns into received / spent / receivedBack", () => {
    const a = monthActuals(accounts, [
      txn("2026-08-01", [["salary", -100000], ["bank", 100000]], done),
      txn("2026-08-02", [["bank", -6000], ["expense", 6000]], done),
      txn("2026-08-03", [["person", -2000], ["bank", 2000]], done),
    ], [], 0);
    expect(a.received).toBe(100000);
    expect(a.spent).toBe(6000);
    expect(a.receivedBack).toBe(2000);
  });

  it("buckets pending txns into incomeToCome / stillToGo / comingBack", () => {
    const a = monthActuals(accounts, [
      txn("2026-08-20", [["salary", -50000], ["bank", 50000]]),
      txn("2026-08-21", [["bank", -7000], ["expense", 7000]]),
      txn("2026-08-22", [["person", -3000], ["bank", 3000]]),
    ], [], 0);
    expect(a.incomeToCome).toBe(50000);
    expect(a.stillToGo).toBe(7000);
    expect(a.comingBack).toBe(3000);
  });

  it("ignores card swipes (they live in cardToPay), internal moves and equity entries", () => {
    const equity = acc({ id: "equity", kind: "equity", subtype: "opening_balance" });
    const a = monthActuals([...accounts, equity], [
      txn("2026-08-02", [["card", -9000], ["expense", 9000]], done),
      txn("2026-08-03", [["bank", -3000], ["bank2", 3000]], done),
      txn("2026-08-01", [["bank", 99999], ["equity", -99999]], done),
    ], [], 12345);
    expect(a.spent).toBe(0);
    expect(a.received).toBe(0);
    expect(a.cardToPay).toBe(12345);
  });

  it("counts a card-bill payment as spent (its debt reduction shows in cardToPay)", () => {
    const a = monthActuals(accounts, [
      txn("2026-08-03", [["bank", -47741], ["card", 47741]], done),
    ], [], 0);
    expect(a.spent).toBe(47741);
  });

  it("adds unposted templates to the remaining side, skips posted ones", () => {
    const postedTxn = txn("2026-08-03", [["bank", -30000], ["expense", 30000]],
      { ...done, recurring_template_id: "rentT" });
    const a = monthActuals(accounts, [postedTxn], [salaryT, rentT, budgetT, internalT], 0);
    expect(a.incomeToCome).toBe(100000); // salary not yet posted
    expect(a.spent).toBe(30000); // rent posted → actual
    expect(a.stillToGo).toBe(15000); // budget yes, internal no, rent already posted
  });

  it("excludes card-charged templates from stillToGo", () => {
    const a = monthActuals(accounts, [], [cardEmiT, subcardT], 0);
    expect(a.stillToGo).toBe(0);
  });

  it("expects template reimbursements until the person has actually paid", () => {
    const a1 = monthActuals(accounts, [], [reimburseT], 0);
    expect(a1.comingBack).toBe(8500);
    const paid = txn("2026-08-05", [["person", -8500], ["bank", 8500]], done);
    const a2 = monthActuals(accounts, [paid], [reimburseT], 0);
    expect(a2.comingBack).toBe(0);
    expect(a2.receivedBack).toBe(8500);
  });

  it("counts a txn-level split (no template reimburse) as coming back until repaid", () => {
    const emiSplit = txn(
      "2026-08-06",
      [["bank", -17099], ["expense", 8550], ["person", 8549]],
      { status: "done", reimburse_account_id: "person", reimburse_amount_paise: 8549 }
    );
    expect(monthActuals(accounts, [emiSplit], [], 0).comingBack).toBe(8549);
    const repaid = txn("2026-08-12", [["person", -8549], ["bank", 8549]], { status: "done" });
    const a = monthActuals(accounts, [emiSplit, repaid], [], 0);
    expect(a.comingBack).toBe(0);
    expect(a.receivedBack).toBe(8549);
  });

  it("does not double-count a split that a template already declares", () => {
    const postedSplit = txn(
      "2026-08-05",
      [["bank", -17000], ["expense", 8500], ["person", 8500]],
      { status: "done", recurring_template_id: "reimburseT",
        reimburse_account_id: "person", reimburse_amount_paise: 8500 }
    );
    expect(monthActuals(accounts, [postedSplit], [reimburseT], 0).comingBack).toBe(8500);
  });

  it("projected savings declines as ad-hoc spends are logged", () => {
    const before = monthActuals(accounts, [], [salaryT, rentT], 20000);
    const after = monthActuals(accounts, [
      txn("2026-08-02", [["bank", -6000], ["expense", 6000]], done),
    ], [salaryT, rentT], 20000);
    expect(before.projectedSavings).toBe(100000 - 30000 - 20000);
    expect(after.projectedSavings).toBe(before.projectedSavings - 6000);
  });

  it("projected savings is unchanged by posting a template at its planned amount", () => {
    const before = monthActuals(accounts, [], [rentT], 0);
    const after = monthActuals(accounts, [
      txn("2026-08-03", [["bank", -30000], ["expense", 30000]],
        { ...done, recurring_template_id: "rentT" }),
    ], [rentT], 0);
    expect(after.projectedSavings).toBe(before.projectedSavings);
  });
});

describe("liquidOutlook", () => {
  it("projects month-end liquid from what is still to land", () => {
    const a = monthActuals(accounts, [], [salaryT, rentT], 20000);
    // toPay = card 20000 + rent 30000; toReceive = salary 100000
    const o = liquidOutlook(a, 194_00);
    expect(o.toPay).toBe(50000);
    expect(o.toReceive).toBe(100000);
    expect(o.projected).toBe(194_00 - 50000 + 100000);
  });

  it("does not double-count what already happened — it is inside liquid", () => {
    const done = { status: "done" as const };
    const before = liquidOutlook(monthActuals(accounts, [], [rentT], 0), 100000);
    // paying rent moves 30000 out of liquid AND out of toPay — projection unchanged
    const after = liquidOutlook(
      monthActuals(accounts, [
        txn("2026-08-03", [["bank", -30000], ["expense", 30000]],
          { ...done, recurring_template_id: "rentT" }),
      ], [rentT], 0),
      100000 - 30000
    );
    expect(after.projected).toBe(before.projected);
  });
});

describe("oneOffsFor", () => {
  it("filters by calendar month", () => {
    const a = txn("2026-09-01", [["bank", -1], ["expense", 1]]);
    const b = txn("2026-10-01", [["bank", -1], ["expense", 1]]);
    expect(oneOffsFor([a, b], "2026-09")).toEqual([a]);
    expect(oneOffsFor([a, b], "2026-11")).toEqual([]);
  });
});

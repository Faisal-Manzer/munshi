import { describe, expect, it } from "vitest";
import type { Account } from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import {
  proposeAccount,
  proposeCardEmi,
  proposeLoan,
  proposeReconcile,
  renderPreview,
} from "@munshi/mcp";

const account = (over: Partial<Account> & { id: string; name: string }): Account => ({
  user_id: "u1",
  ledger_id: "l1",
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
  is_liquid: true,
  ...over,
});

const bank = account({ id: "bank", name: "ICICI main" });
const envelope = account({ id: "env", name: "Rent envelope", subtype: "envelope", parent_id: "bank" });
const food = account({ id: "food", name: "Food", kind: "expense", subtype: "general_expense" });
const farzan = account({ id: "farzan", name: "Farzan", subtype: "receivable", is_liquid: false });

// ₹2,40,000 in the bank, ₹10,000 of it sitting in the rent envelope
const snapshot: LedgerSnapshot = {
  accounts: [bank, envelope, food, farzan],
  transactions: [
    { id: "t0", ledger_id: "l1", date: "2026-08-01", description: "Opening", status: "done", tag: null, recurring_template_id: null, reimburse_account_id: null, reimburse_amount_paise: null, notes: null },
  ],
  postings: [
    { id: "p0", transaction_id: "t0", account_id: "bank", amount_paise: 23000000 },
    { id: "p1", transaction_id: "t0", account_id: "env", amount_paise: 1000000 },
    { id: "p2", transaction_id: "t0", account_id: "food", amount_paise: -24000000 },
  ],
  templates: [],
};

let n = 0;
const mint = () => `minted-${++n}`;

describe("proposeAccount", () => {
  it("writes no postings when there is no opening balance", () => {
    const op = proposeAccount(snapshot, {
      ledgerId: "l1",
      type: "credit_card",
      name: "Amazon Pay ICICI",
      statementDay: 18,
      dueDay: 5,
      creditLimitPaise: 20000000,
      today: "2026-08-17",
    }, mint);
    expect(op.ops).toHaveLength(1);
    expect(op.preview.entries).toHaveLength(0);
    expect(op.preview.warnings[0]).toContain("starts at zero");
  });

  it("books an opening balance against equity, not against spending", () => {
    const op = proposeAccount(snapshot, {
      ledgerId: "l1",
      type: "credit_card",
      name: "HDFC card",
      openingBalancePaise: 4832000,
      today: "2026-08-17",
    }, mint);
    // account + equity account + the balanced entry
    expect(op.ops.map((o) => o.kind)).toEqual([
      "account.create",
      "account.create",
      "entry.create",
    ]);
    expect(op.preview.deltas).toContainEqual({
      account: "HDFC card",
      beforePaise: 0,
      afterPaise: 4832000, // a liability reads as what is owed
    });
    expect(op.preview.explanation).toContain("lands as equity");
  });

  it("refuses a second account with the same name", () => {
    expect(() =>
      proposeAccount(snapshot, { ledgerId: "l1", type: "bank", name: "icici main", today: "2026-08-17" }, mint)
    ).toThrow(/already has an account/);
  });

  it("refuses an envelope with no bank to sit under", () => {
    expect(() =>
      proposeAccount(snapshot, { ledgerId: "l1", type: "envelope", name: "Fuel", today: "2026-08-17" }, mint)
    ).toThrow(/name the parent account/);
  });
});

describe("proposeReconcile", () => {
  const base = { ledgerId: "l1", today: "2026-08-17", nowISO: "2026-08-17T09:00:00.000Z" };

  it("counts a bank's envelopes as part of the pot", () => {
    // book is 2,30,000 + 10,000 = 2,40,000; the bank app says 2,38,400
    const op = proposeReconcile(snapshot, { ...base, accountId: "bank", realBalancePaise: 23840000 }, mint);
    const entry = op.ops.find((o) => o.kind === "entry.create");
    expect(entry).toBeDefined();
    expect(op.preview.explanation).toContain("higher than ICICI main");
    const text = renderPreview(op.preview);
    expect(text).toContain("₹2,40,000.00");
    expect(text).toContain("₹2,38,400.00");
  });

  it("posts the gap to Adjustments, creating it once", () => {
    const op = proposeReconcile(snapshot, { ...base, accountId: "bank", realBalancePaise: 23840000 }, mint);
    expect(op.ops.map((o) => o.kind)).toEqual([
      "account.create", // Adjustments did not exist
      "entry.create",
      "account.update", // the reported stamp
    ]);
  });

  it("records the check and posts nothing when the book already matches", () => {
    const op = proposeReconcile(snapshot, { ...base, accountId: "bank", realBalancePaise: 24000000 }, mint);
    expect(op.ops.map((o) => o.kind)).toEqual(["account.update"]);
    expect(op.preview.explanation).toContain("already matches");
  });

  it("can record the real figure without closing the gap", () => {
    const op = proposeReconcile(
      snapshot,
      { ...base, accountId: "bank", realBalancePaise: 23840000, applyAdjustment: false },
      mint
    );
    expect(op.ops.map((o) => o.kind)).toEqual(["account.update"]);
    expect(op.preview.warnings[0]).toContain("not closed");
  });

  it("asks which way a person's debt runs", () => {
    expect(() =>
      proposeReconcile(snapshot, { ...base, accountId: "farzan", realBalancePaise: 50000 }, mint)
    ).toThrow(/owes you or you owe them/);
  });

  it("flips the sign when the person is owed money", () => {
    const op = proposeReconcile(
      snapshot,
      { ...base, accountId: "farzan", realBalancePaise: 50000, owesMe: false },
      mint
    );
    const update = op.ops.find((o) => o.kind === "account.update");
    expect(update && "patch" in update && update.patch.reported_balance_paise).toBe(-50000);
  });
});

const card = account({
  id: "card",
  name: "Amazon Pay ICICI",
  kind: "liability",
  subtype: "credit_card",
  statement_day: 18,
  due_day: 5,
  credit_limit_paise: 20000000,
  is_liquid: false,
});
const withCard: LedgerSnapshot = { ...snapshot, accounts: [...snapshot.accounts, card] };

describe("proposeLoan", () => {
  const base = { ledgerId: "l1", counterAccountId: "bank", today: "2026-08-17" };

  it("creates the account, the disbursal and the repayment as one thing", () => {
    const op = proposeLoan(withCard, {
      ...base,
      direction: "borrowed",
      name: "Bike loan — HDFC",
      principalPaise: 10000000,
      ratePercent: 10,
      months: 12,
      firstDueISO: "2026-09-05",
    }, mint);
    expect(op.ops.map((o) => o.kind)).toEqual([
      "account.create",
      "entry.create",
      "template.create",
    ]);
  });

  it("grows a liability when borrowing and cash along with it", () => {
    const op = proposeLoan(withCard, {
      ...base,
      direction: "borrowed",
      name: "Bike loan",
      principalPaise: 10000000,
      ratePercent: 10,
      months: 12,
      firstDueISO: "2026-09-05",
    }, mint);
    expect(op.preview.deltas).toContainEqual({
      account: "Bike loan",
      beforePaise: 0,
      afterPaise: 10000000, // owed
    });
    expect(op.preview.deltas).toContainEqual({
      account: "ICICI main",
      beforePaise: 23000000,
      afterPaise: 33000000,
    });
  });

  it("takes money out of the bank when lending", () => {
    const op = proposeLoan(withCard, {
      ...base,
      direction: "lent",
      name: "Ahmed",
      principalPaise: 10000000,
      ratePercent: 0,
      months: 10,
      firstDueISO: "2026-09-05",
    }, mint);
    expect(op.preview.deltas).toContainEqual({
      account: "ICICI main",
      beforePaise: 23000000,
      afterPaise: 13000000,
    });
    expect(op.preview.deltas).toContainEqual({
      account: "Ahmed",
      beforePaise: 0,
      afterPaise: 10000000, // they owe you
    });
  });

  it("says out loud that the interest split is not posted", () => {
    const op = proposeLoan(withCard, {
      ...base,
      direction: "borrowed",
      name: "Bike loan",
      principalPaise: 10000000,
      ratePercent: 10,
      months: 12,
      firstDueISO: "2026-09-05",
    }, mint);
    expect(op.preview.warnings.join(" ")).toContain("not booked as an expense");
  });

  it("refuses a principal of zero", () => {
    expect(() =>
      proposeLoan(withCard, {
        ...base,
        direction: "borrowed",
        name: "x",
        principalPaise: 0,
        ratePercent: 10,
        months: 12,
        firstDueISO: "2026-09-05",
      }, mint)
    ).toThrow(/greater than zero/);
  });
});

describe("proposeCardEmi", () => {
  const base = {
    ledgerId: "l1",
    cardId: "card",
    expenseAccountId: "food",
    description: "MacBook",
    firstBillingISO: "2026-09-18",
    today: "2026-08-17",
  };

  it("adds a template and moves nothing today", () => {
    const op = proposeCardEmi(withCard, { ...base, totalPaise: 12000000, months: 6 }, mint);
    expect(op.ops.map((o) => o.kind)).toEqual(["template.create"]);
    expect(op.preview.deltas).toEqual([]);
    expect(op.preview.explanation).toContain("not a new spend each month");
  });

  it("refuses when the purchase is already in the book", () => {
    const already: LedgerSnapshot = {
      ...withCard,
      transactions: [
        ...withCard.transactions,
        { id: "t1", ledger_id: "l1", date: "2026-08-10", description: "MacBook", status: "done", tag: null, recurring_template_id: null, reimburse_account_id: null, reimburse_amount_paise: null, notes: null },
      ],
      postings: [
        ...withCard.postings,
        { id: "p3", transaction_id: "t1", account_id: "card", amount_paise: -12000000 },
        { id: "p4", transaction_id: "t1", account_id: "food", amount_paise: 12000000 },
      ],
    };
    expect(() => proposeCardEmi(already, { ...base, totalPaise: 12000000, months: 6 }, mint)).toThrow(
      /count the money twice/
    );
    // told to reverse it, the same proposal carries the reversal
    const op = proposeCardEmi(
      already,
      { ...base, totalPaise: 12000000, months: 6, duplicate: "reverse" },
      mint
    );
    expect(op.ops.map((o) => o.kind)).toEqual(["entry.create", "template.create"]);
    expect(op.preview.deltas).toContainEqual({
      account: "Amazon Pay ICICI",
      beforePaise: 12000000,
      afterPaise: 0,
    });
  });

  it("warns when the total does not divide evenly", () => {
    const op = proposeCardEmi(withCard, { ...base, totalPaise: 10000, months: 3 }, mint);
    expect(op.preview.warnings.join(" ")).toContain("does not divide evenly");
  });

  it("posts a processing fee as its own entry", () => {
    const op = proposeCardEmi(
      withCard,
      { ...base, totalPaise: 12000000, months: 6, processingFeePaise: 59000 },
      mint
    );
    expect(op.ops.map((o) => o.kind)).toEqual(["template.create", "entry.create"]);
    expect(op.preview.deltas).toContainEqual({
      account: "Amazon Pay ICICI",
      beforePaise: 0,
      afterPaise: 59000,
    });
  });
});

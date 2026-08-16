import { describe, expect, it } from "vitest";
import { accountCreateOp, entryCreateOp, entryDeleteOp, type Account } from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { affectedAccountIds, buildPreview, renderPreview, simulate } from "@munshi/mcp";

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
const food = account({ id: "food", name: "Food", kind: "expense", subtype: "general_expense" });
const card = account({
  id: "card",
  name: "Amazon Pay ICICI",
  kind: "liability",
  subtype: "credit_card",
  is_liquid: false,
});

/** ₹2,40,000 sitting in the bank, put there by an opening entry. */
const snapshot: LedgerSnapshot = {
  accounts: [bank, food, card],
  transactions: [
    { id: "t0", ledger_id: "l1", date: "2026-08-01", description: "Opening", status: "done", tag: null, recurring_template_id: null, reimburse_account_id: null, reimburse_amount_paise: null, notes: null },
  ],
  postings: [
    { id: "p0", transaction_id: "t0", account_id: "bank", amount_paise: 24000000 },
    { id: "p1", transaction_id: "t0", account_id: "food", amount_paise: -24000000 },
  ],
  templates: [],
};

const chai = entryCreateOp({
  ledgerId: "l1",
  date: "2026-08-17",
  description: "Chai",
  status: "done",
  fromAccountId: "bank",
  toAccountId: "food",
  amountPaise: 4000,
});

describe("simulate", () => {
  it("leaves the snapshot it was given alone", () => {
    simulate(snapshot, [chai]);
    expect(snapshot.transactions).toHaveLength(1);
    expect(snapshot.postings).toHaveLength(2);
  });

  it("applies an entry without writing anything", () => {
    const after = simulate(snapshot, [chai]);
    expect(after.transactions).toHaveLength(2);
    expect(after.postings).toHaveLength(4);
  });

  it("removes a deleted entry's legs", () => {
    const after = simulate(snapshot, [entryDeleteOp("t0")]);
    expect(after.transactions).toHaveLength(0);
    expect(after.postings).toHaveLength(0);
  });
});

describe("affectedAccountIds", () => {
  it("covers accounts a delete only touches through existing rows", () => {
    // the op names a transaction, not an account, but both balances move
    expect(affectedAccountIds(snapshot, [entryDeleteOp("t0")]).sort()).toEqual([
      "bank",
      "food",
    ]);
  });
});

describe("buildPreview", () => {
  it("shows the postings, the balance change and the explanation", () => {
    const p = buildPreview(snapshot, [chai], {
      title: "Chai ₹40",
      explanation: "₹40 leaves ICICI main and lands in Food.",
    });
    expect(p.entries[0].postings).toEqual([
      { account: "ICICI main", amountPaise: -4000 },
      { account: "Food", amountPaise: 4000 },
    ]);
    expect(p.deltas).toContainEqual({
      account: "ICICI main",
      beforePaise: 24000000,
      afterPaise: 23996000,
    });
  });

  it("reads a liability as what is owed, not as a negative asset", () => {
    const spend = entryCreateOp({
      ledgerId: "l1",
      date: "2026-08-17",
      description: "Groceries",
      status: "done",
      fromAccountId: "card",
      toAccountId: "food",
      amountPaise: 150000,
    });
    const p = buildPreview(snapshot, [spend], { title: "x", explanation: "y" });
    expect(p.deltas).toContainEqual({
      account: "Amazon Pay ICICI",
      beforePaise: 0,
      afterPaise: 150000,
    });
  });

  it("gives a real before and after for an account the same batch creates", () => {
    const loan = accountCreateOp({
      id: "loan-1",
      ledger_id: "l1",
      name: "Bike loan",
      kind: "liability",
      subtype: "loan",
      parent_id: null,
      statement_day: null,
      due_day: 5,
      credit_limit_paise: null,
      person_name: null,
      reported_balance_paise: null,
      reported_at: null,
      sort_order: 0,
      archived: false,
      is_liquid: false,
    });
    const disbursal = entryCreateOp({
      ledgerId: "l1",
      date: "2026-09-01",
      description: "Disbursal",
      status: "done",
      fromAccountId: "loan-1",
      toAccountId: "bank",
      amountPaise: 10000000,
    });
    const p = buildPreview(snapshot, [loan, disbursal], {
      title: "Loan",
      explanation: "You borrow ₹1L.",
    });
    expect(p.deltas).toContainEqual({
      account: "Bike loan",
      beforePaise: 0,
      afterPaise: 10000000,
    });
    expect(p.changes[0]).toContain("New account: Bike loan");
  });

  it("omits accounts whose balance does not move", () => {
    const p = buildPreview(snapshot, [chai], { title: "x", explanation: "y" });
    expect(p.deltas.map((d) => d.account)).not.toContain("Amazon Pay ICICI");
  });
});

describe("renderPreview", () => {
  it("puts debits and credits before the numbers and the words after", () => {
    const text = renderPreview(
      buildPreview(snapshot, [chai], {
        title: "Chai ₹40",
        explanation: "₹40 leaves ICICI main and lands in Food.",
        warnings: ["Balance is getting low."],
      })
    );
    expect(text).toContain("Cr  ICICI main");
    expect(text).toContain("Dr  Food");
    expect(text.indexOf("Dr  Food")).toBeLessThan(text.indexOf("₹40 leaves"));
    expect(text).toContain("! Balance is getting low.");
  });
});

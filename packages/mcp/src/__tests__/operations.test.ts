import { describe, expect, it } from "vitest";
import type { Account } from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { proposeAccount, proposeReconcile, renderPreview } from "@munshi/mcp";

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

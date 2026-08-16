import { describe, expect, it } from "vitest";
import {
  accountCreateOp,
  assertBatchValid,
  createdIds,
  entryCreateOp,
  templateCreateOp,
  validateBatch,
  type LedgerOp,
  type NewAccount,
  type NewTemplate,
} from "@munshi/core";

const newAccount = (id: string): NewAccount & { id: string } => ({
  id,
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

const newTemplate = (id: string, from: string, to: string): NewTemplate & { id: string } => ({
  id,
  ledger_id: "l1",
  name: "Bike loan EMI",
  kind: "autodebit_bank",
  day_of_month: 5,
  amount_paise: 879200,
  from_account_id: from,
  to_account_id: to,
  reimburse_account_id: null,
  reimburse_amount_paise: null,
  reimburse_expected_day: null,
  total_installments: 12,
  installments_done: 0,
  is_budget: false,
  start_date: "2026-09-05",
  end_date: null,
  active: true,
  notes: null,
});

const entry = (from: string, to: string, paise = 10000000): LedgerOp =>
  entryCreateOp({
    ledgerId: "l1",
    date: "2026-09-01",
    description: "Disbursal",
    status: "done",
    fromAccountId: from,
    toAccountId: to,
    amountPaise: paise,
  });

describe("validateBatch", () => {
  it("accepts an entry between accounts that already exist", () => {
    expect(validateBatch([entry("bank", "loan")], ["bank", "loan"])).toEqual([]);
  });

  it("rejects an empty batch", () => {
    expect(validateBatch([])).toEqual([{ index: -1, message: "Batch is empty." }]);
  });

  it("lets a later op post against an account an earlier op creates", () => {
    // the whole point of minting ids up front: a loan is the account plus the
    // disbursal plus the repayment template, approved as one thing
    const ops = [
      accountCreateOp(newAccount("loan-1")),
      entry("bank", "loan-1"),
      templateCreateOp(newTemplate("tpl-1", "bank", "loan-1")),
    ];
    expect(validateBatch(ops, ["bank"])).toEqual([]);
    expect(createdIds(ops)).toEqual(["loan-1", "tpl-1"]);
  });

  it("rejects posting against an account created later in the batch", () => {
    const problems = validateBatch(
      [entry("bank", "loan-1"), accountCreateOp(newAccount("loan-1"))],
      ["bank"]
    );
    expect(problems).toEqual([{ index: 0, message: "Unknown account loan-1." }]);
  });

  it("rejects an unknown account", () => {
    expect(validateBatch([entry("bank", "nope")], ["bank"])).toEqual([
      { index: 0, message: "Unknown account nope." },
    ]);
  });

  it("does not let a template id stand in for an account", () => {
    const ops = [
      templateCreateOp(newTemplate("tpl-1", "bank", "loan-1")),
      entry("bank", "tpl-1"),
    ];
    const problems = validateBatch(ops, ["bank", "loan-1"]);
    expect(problems).toEqual([{ index: 1, message: "Unknown account tpl-1." }]);
  });

  it("rejects a duplicate minted id", () => {
    const problems = validateBatch(
      [accountCreateOp(newAccount("loan-1")), accountCreateOp(newAccount("loan-1"))],
      []
    );
    expect(problems).toEqual([{ index: 1, message: "Duplicate id loan-1." }]);
  });

  it("reports every problem, not only the first", () => {
    const problems = validateBatch([entry("bank", "nope"), entry("nope", "bank")], ["bank"]);
    expect(problems).toHaveLength(2);
  });

  it("catches unbalanced legs the database can no longer see", () => {
    const unbalanced: LedgerOp = {
      kind: "entry.create",
      ledgerId: "l1",
      txn: { date: "2026-09-01", description: "wrong", status: "done" },
      postings: [
        { account_id: "bank", amount_paise: -100 },
        { account_id: "loan", amount_paise: 90 },
      ],
    };
    const problems = validateBatch([unbalanced], ["bank", "loan"]);
    expect(problems[0].message).toContain("does not balance");
  });
});

describe("assertBatchValid", () => {
  it("throws listing each problem", () => {
    expect(() => assertBatchValid([entry("a", "b")], [])).toThrow(/Unknown account a/);
  });

  it("stays quiet on a good batch", () => {
    expect(() => assertBatchValid([entry("a", "b")], ["a", "b"])).not.toThrow();
  });
});

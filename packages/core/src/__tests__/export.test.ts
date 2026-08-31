import { describe, expect, it } from "vitest";
import { exportCsvs, exportJson, toCsv } from "../export";
import type { Account, Posting, RecurringTemplate, Transaction } from "../types";

const acc = (over: Partial<Account> & Pick<Account, "id" | "name">): Account => ({
  user_id: "u", ledger_id: "L", kind: "asset", subtype: "bank", parent_id: null,
  statement_day: null, due_day: null, credit_limit_paise: null, person_name: null,
  reported_balance_paise: null, reported_at: null, sort_order: 0, archived: false,
  is_liquid: true, ...over,
});

const bank = acc({ id: "a1", name: "ICICI" });
const food = acc({ id: "a2", name: "Food", kind: "expense", subtype: "general_expense", is_liquid: false });
const rent = acc({ id: "a3", name: "Rent", kind: "expense", subtype: "general_expense", is_liquid: false });

const txn: Transaction = {
  id: "t1", ledger_id: "L", date: "2026-08-04", description: 'Lunch, "the usual"',
  status: "done", tag: "avoidable", recurring_template_id: null,
  reimburse_account_id: null, reimburse_amount_paise: null, notes: null,
  payload: "CIPHERTEXT",
};
const postings: Posting[] = [
  { id: "p1", transaction_id: "t1", account_id: "a1", amount_paise: -45000, payload: "X" },
  { id: "p2", transaction_id: "t1", account_id: "a2", amount_paise: 30000 },
  { id: "p3", transaction_id: "t1", account_id: "a3", amount_paise: 15000 },
];
const tpl: RecurringTemplate = {
  id: "r1", ledger_id: "L", name: "Rent", kind: "autodebit_bank", day_of_month: 3,
  amount_paise: 2500000, from_account_id: "a1", to_account_id: "a3",
  reimburse_account_id: null, reimburse_amount_paise: null, reimburse_expected_day: null,
  total_installments: null, installments_done: 0, is_budget: false,
  start_date: null, end_date: null, active: true, notes: null,
};

const input = {
  ledger: { id: "L", name: "My Book" },
  accounts: [bank, food, rent],
  transactions: [txn],
  postings,
  templates: [tpl],
};

describe("toCsv", () => {
  it("quotes every cell and doubles embedded quotes", () => {
    expect(toCsv(["a"], [['say "hi", ok']])).toBe('"a"\r\n"say ""hi"", ok"\r\n');
  });

  it("leaves a blank for null and undefined, never the words", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe('"a","b"\r\n,\r\n');
  });
});

describe("exportJson", () => {
  const at = new Date(2026, 7, 31, 12, 0, 0);
  const file = exportJson(input, at);
  const parsed = JSON.parse(file.content);

  it("names the file for the book and the local day", () => {
    expect(file.name).toBe("my-book-2026-08-31.json");
  });

  it("drops the ciphertext — it duplicates the plaintext beside it", () => {
    expect(parsed.transactions[0]).not.toHaveProperty("payload");
    expect(parsed.postings[0]).not.toHaveProperty("payload");
    expect(parsed.transactions[0].description).toBe('Lunch, "the usual"');
  });

  it("keeps ids and paise so the archive round-trips", () => {
    expect(parsed.accounts.map((a: Account) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(parsed.postings[0].amount_paise).toBe(-45000);
    expect(parsed.recurring_templates[0].amount_paise).toBe(2500000);
  });
});

describe("exportCsvs", () => {
  const files = exportCsvs(input);
  const byName = new Map(files.map((f) => [f.name, f.content]));

  it("writes one sheet per table plus the flat entry sheet", () => {
    expect([...byName.keys()]).toEqual([
      "entries.csv", "accounts.csv", "postings.csv", "recurring.csv",
    ]);
  });

  it("resolves ids to names and paise to rupees", () => {
    const line = byName.get("entries.csv")!.split("\r\n")[1];
    expect(line).toContain('"ICICI"');
    expect(line).toContain('"Food"');
    expect(line).toContain('"300.00"');
  });

  it("carries a split's extra legs instead of dropping them", () => {
    // biggest debit is the entry's amount; the smaller one must still show up
    const line = byName.get("entries.csv")!.split("\r\n")[1];
    expect(line).toContain("Rent 150.00");
  });

  it("escapes a description that contains quotes and commas", () => {
    expect(byName.get("entries.csv")).toContain('"Lunch, ""the usual"""');
  });
});

import { describe, expect, it } from "vitest";
import {
  computeBalances,
  computeCardCycles,
  statementCutoff,
  type Account,
  type LedgerData,
  type Posting,
  type Transaction,
} from "@munshi/core";

/**
 * These assertions encode what the SQL views did. If a future change to the
 * TypeScript disagrees with Postgres, the app would silently show different
 * money than the database — so the odd corners (zero rows for untouched
 * accounts, pending excluded from cycles, February clamping) are pinned here
 * on purpose.
 */

function account(id: string, patch: Partial<Account> = {}): Account {
  return {
    id,
    user_id: "u",
    ledger_id: "l",
    name: id,
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
    ...patch,
  };
}

function txn(id: string, date: string, status: Transaction["status"] = "done"): Transaction {
  return {
    id,
    ledger_id: "l",
    date,
    description: id,
    status,
    tag: null,
    recurring_template_id: null,
    reimburse_account_id: null,
    reimburse_amount_paise: null,
    notes: null,
  };
}

function posting(transaction_id: string, account_id: string, amount_paise: number): Posting {
  return { id: `${transaction_id}-${account_id}`, transaction_id, account_id, amount_paise };
}

describe("computeBalances", () => {
  it("splits a balance into settled and pending", () => {
    const data: LedgerData = {
      accounts: [account("bank"), account("spends", { kind: "expense", subtype: "general_expense" })],
      transactions: [txn("t1", "2026-08-01"), txn("t2", "2026-08-02", "pending")],
      postings: [
        posting("t1", "bank", -10000),
        posting("t1", "spends", 10000),
        posting("t2", "bank", -5000),
        posting("t2", "spends", 5000),
      ],
    };
    const bal = computeBalances(data);
    expect(bal.get("bank")).toEqual({
      account_id: "bank",
      balance_paise: -15000,
      settled_paise: -10000,
      pending_paise: -5000,
    });
    expect(bal.get("spends")?.balance_paise).toBe(15000);
  });

  it("reports a zero row for an account that was never posted to", () => {
    // the SQL used a left join, so an untouched account still appeared
    const bal = computeBalances({ accounts: [account("fresh")], transactions: [], postings: [] });
    expect(bal.get("fresh")).toEqual({
      account_id: "fresh",
      balance_paise: 0,
      settled_paise: 0,
      pending_paise: 0,
    });
  });

  it("always balances to zero across every account of an entry", () => {
    const data: LedgerData = {
      accounts: [account("a"), account("b"), account("c")],
      transactions: [txn("t1", "2026-08-01")],
      postings: [posting("t1", "a", -10000), posting("t1", "b", 6000), posting("t1", "c", 4000)],
    };
    const total = [...computeBalances(data).values()].reduce((s, r) => s + r.balance_paise, 0);
    expect(total).toBe(0);
  });
});

describe("statementCutoff", () => {
  it("uses this month's statement once it has passed", () => {
    expect(statementCutoff(3, new Date(2026, 7, 9))).toBe("2026-08-03");
  });

  it("falls back to last month when this month's has not arrived", () => {
    expect(statementCutoff(19, new Date(2026, 7, 9))).toBe("2026-07-19");
  });

  it("clamps to the last day of a short month", () => {
    // a card billing on the 30th has no 30 February
    expect(statementCutoff(30, new Date(2026, 1, 28))).toBe("2026-02-28");
    expect(statementCutoff(31, new Date(2026, 3, 15))).toBe("2026-03-31");
  });

  it("falls back to today when no statement day is set", () => {
    expect(statementCutoff(null, new Date(2026, 7, 9))).toBe("2026-08-09");
  });
});

describe("computeCardCycles", () => {
  const today = new Date(2026, 7, 9); // 9 Aug 2026

  const cardData = (postings: Posting[], transactions: Transaction[]): LedgerData => ({
    accounts: [
      account("card", { kind: "liability", subtype: "credit_card", statement_day: 3 }),
    ],
    transactions,
    postings,
  });

  it("bills what happened on or before the cutoff, and tracks movement since", () => {
    const data = cardData(
      [
        posting("old", "card", -50000),  // spend before the cutoff → billed
        posting("pay", "card", 20000),   // payment after → payments_since
        posting("new", "card", -3000),   // spend after → spends_since
      ],
      [txn("old", "2026-08-01"), txn("pay", "2026-08-05"), txn("new", "2026-08-07")]
    );
    expect(computeCardCycles(data, today).get("card")).toEqual({
      account_id: "card",
      cutoff: "2026-08-03",
      billed_paise: -50000,
      payments_since_paise: 20000,
      spends_since_paise: -3000,
    });
  });

  it("counts an entry dated exactly on the cutoff as billed", () => {
    const data = cardData([posting("t1", "card", -1000)], [txn("t1", "2026-08-03")]);
    expect(computeCardCycles(data, today).get("card")?.billed_paise).toBe(-1000);
  });

  it("ignores pending entries entirely", () => {
    // the SQL joined transactions with status = 'done'
    const data = cardData(
      [posting("t1", "card", -1000), posting("t2", "card", -2000)],
      [txn("t1", "2026-08-01"), txn("t2", "2026-08-07", "pending")]
    );
    const cycle = computeCardCycles(data, today).get("card");
    expect(cycle?.billed_paise).toBe(-1000);
    expect(cycle?.spends_since_paise).toBe(0);
  });

  it("inherits the parent card's statement day", () => {
    const data: LedgerData = {
      accounts: [
        account("parent", { kind: "liability", subtype: "credit_card", statement_day: 3 }),
        account("sub", { kind: "liability", subtype: "credit_card", parent_id: "parent" }),
      ],
      transactions: [txn("t1", "2026-08-01")],
      postings: [posting("t1", "sub", -1000)],
    };
    const cycles = computeCardCycles(data, today);
    expect(cycles.get("sub")?.cutoff).toBe("2026-08-03");
    expect(cycles.get("sub")?.billed_paise).toBe(-1000);
  });

  it("covers only credit cards", () => {
    const data: LedgerData = {
      accounts: [account("bank"), account("card", { kind: "liability", subtype: "credit_card" })],
      transactions: [],
      postings: [],
    };
    const cycles = computeCardCycles(data, today);
    expect(cycles.has("bank")).toBe(false);
    expect(cycles.has("card")).toBe(true);
  });
});

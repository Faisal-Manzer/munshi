import { describe, expect, it } from "vitest";
import {
  describePlan, guessColumns, looksLikeHeader, parseDelimited, parseImportAmount,
  parseImportDate, planRestore, planSheet, planToOps, readArchive, sniffDelimiter,
  type ImportContext, type SheetMapping,
} from "../import";
import { exportJson } from "../export";
import { validateBatch } from "../ops";
import type { Account, Posting, Transaction } from "../types";

const acc = (over: Partial<Account> & Pick<Account, "id" | "name">): Account => ({
  user_id: "u", ledger_id: "L", kind: "asset", subtype: "bank", parent_id: null,
  statement_day: null, due_day: null, credit_limit_paise: null, person_name: null,
  reported_balance_paise: null, reported_at: null, sort_order: 0, archived: false,
  is_liquid: true, ...over,
});

const bank = acc({ id: "a1", name: "ICICI" });
const food = acc({ id: "a2", name: "Food", kind: "expense", subtype: "general_expense", is_liquid: false });
const salary = acc({ id: "a3", name: "Salary", kind: "income", subtype: "salary", is_liquid: false });

let seq = 0;
const ctx = (over: Partial<ImportContext> = {}): ImportContext => {
  seq = 0;
  return {
    ledgerId: "L", accounts: [bank, food, salary], transactions: [], postings: [],
    newId: () => `new${++seq}`, ...over,
  };
};

const mapping = (over: Partial<SheetMapping> = {}): SheetMapping => ({
  columns: [], hasHeader: true, dayFirst: true, accountId: "a1",
  spendToId: "a2", receiveFromId: "a3", createMissing: false, onDuplicate: "skip",
  ...over,
});

describe("parseDelimited", () => {
  it("keeps a delimiter and a newline inside a quoted field", () => {
    expect(parseDelimited('a,b\r\n"x,1","y\nz"\r\n')).toEqual([["a", "b"], ["x,1", "y\nz"]]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseDelimited('"say ""hi"""')).toEqual([['say "hi"']]);
  });

  it("strips a UTF-8 BOM so the first header is not mis-read", () => {
    expect(parseDelimited("﻿Date,Amount\n1,2")[0]).toEqual(["Date", "Amount"]);
  });

  it("drops the blank lines banks pad statements with", () => {
    expect(parseDelimited("a,b\n\n\nc,d\n")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("sniffs a semicolon file", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(parseDelimited("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("parseImportDate", () => {
  it("reads ISO regardless of the dayFirst flag", () => {
    expect(parseImportDate("2026-08-04", false)).toBe("2026-08-04");
    expect(parseImportDate("2026/08/04", true)).toBe("2026-08-04");
  });

  it("honours dayFirst on an ambiguous slash date", () => {
    expect(parseImportDate("03/04/2026", true)).toBe("2026-04-03");
    expect(parseImportDate("03/04/2026", false)).toBe("2026-03-04");
  });

  it("ignores dayFirst when one number cannot be a month", () => {
    expect(parseImportDate("28/07/2026", false)).toBe("2026-07-28");
  });

  it("reads the month-name forms statements print", () => {
    expect(parseImportDate("04 Aug 2026")).toBe("2026-08-04");
    expect(parseImportDate("4-Aug-26")).toBe("2026-08-04");
    expect(parseImportDate("Aug 4, 2026")).toBe("2026-08-04");
  });

  it("converts an Excel serial, and only a plausible one", () => {
    expect(parseImportDate(46238)).toBe("2026-08-04");
    expect(parseImportDate(450)).toBeNull(); // an amount that got mapped wrong
  });

  it("takes a real Date in the local zone, not UTC's day", () => {
    expect(parseImportDate(new Date(2026, 7, 4, 23, 30))).toBe("2026-08-04");
  });

  it("refuses a date that does not exist", () => {
    expect(parseImportDate("31/02/2026")).toBeNull();
    expect(parseImportDate("nonsense")).toBeNull();
  });
});

describe("parseImportAmount", () => {
  it("reads Indian grouping and a rupee sign", () => {
    expect(parseImportAmount("₹1,23,456.78")).toBe(12345678);
  });

  it("treats parentheses and a leading minus as negative", () => {
    expect(parseImportAmount("(450.00)")).toBe(-45000);
    expect(parseImportAmount("-450")).toBe(-45000);
  });

  it("reads a Dr/Cr suffix as the direction", () => {
    expect(parseImportAmount("450.00 Dr")).toBe(-45000);
    expect(parseImportAmount("450.00 Cr")).toBe(45000);
  });

  it("returns null for blanks, so a debit/credit pair can be read", () => {
    expect(parseImportAmount("")).toBeNull();
    expect(parseImportAmount(null)).toBeNull();
    expect(parseImportAmount("n/a")).toBeNull();
  });

  it("rounds a float to whole paise", () => {
    expect(parseImportAmount(45.005)).toBe(4501);
  });
});

describe("guessColumns", () => {
  it("recognises a bank statement's headers", () => {
    expect(guessColumns(["Txn Date", "Narration", "Withdrawal", "Deposit", "Balance"]))
      .toEqual(["date", "description", "debit", "credit", "ignore"]);
  });

  it("maps our own entries.csv without any help", () => {
    expect(guessColumns(["date", "description", "from", "to", "amount", "status", "tag", "notes", "other_legs", "transaction_id"]))
      .toEqual(["date", "description", "from", "to", "amount", "status", "tag", "notes", "ignore", "ignore"]);
  });

  it("claims a meaning once — a second Amount column stays ignored", () => {
    expect(guessColumns(["Date", "Amount", "Amount"])).toEqual(["date", "amount", "ignore"]);
  });

  it("tells a header row from a data row", () => {
    expect(looksLikeHeader(["Date", "Narration", "Amount"])).toBe(true);
    expect(looksLikeHeader(["04/08/2026", "Lunch", "450"])).toBe(false);
  });
});

describe("planSheet", () => {
  it("refuses to plan anything without a date or an amount column", () => {
    const plan = planSheet([["x"]], mapping({ columns: ["description"] }), ctx());
    expect(plan.entries).toHaveLength(0);
    expect(plan.problems.map((p) => p.message)).toEqual([
      "No column is mapped to the date.",
      "No column is mapped to an amount (or to debit/credit).",
    ]);
  });

  it("routes a bank statement's debit and credit to the right sides", () => {
    const plan = planSheet(
      [["Date", "Narration", "Withdrawal", "Deposit"],
       ["04/08/2026", "Swiggy", "450.00", ""],
       ["01/08/2026", "August pay", "", "1,50,000.00"]],
      mapping({ columns: ["date", "description", "debit", "credit"] }),
      ctx()
    );
    expect(plan.problems).toEqual([]);
    expect(plan.entries[0]).toMatchObject({
      date: "2026-08-04", description: "Swiggy",
      fromAccountId: "a1", toAccountId: "a2", amountPaise: 45000,
    });
    expect(plan.entries[1]).toMatchObject({
      date: "2026-08-01", fromAccountId: "a3", toAccountId: "a1", amountPaise: 15000000,
    });
  });

  it("lets a signed amount column decide direction the same way", () => {
    const plan = planSheet(
      [["Date", "Desc", "Amount"], ["04/08/2026", "Swiggy", "-450"], ["01/08/2026", "Pay", "150000"]],
      mapping({ columns: ["date", "description", "amount"] }),
      ctx()
    );
    expect(plan.entries[0]).toMatchObject({ fromAccountId: "a1", toAccountId: "a2" });
    expect(plan.entries[1]).toMatchObject({ fromAccountId: "a3", toAccountId: "a1" });
  });

  it("ignores the sign when both sides are named — the columns already said", () => {
    const plan = planSheet(
      [["date", "description", "from", "to", "amount"],
       ["04/08/2026", "Swiggy", "ICICI", "Food", "-450"]],
      mapping({ columns: ["date", "description", "from", "to", "amount"] }),
      ctx()
    );
    expect(plan.entries[0]).toMatchObject({
      fromAccountId: "a1", toAccountId: "a2", amountPaise: 45000,
    });
  });

  it("matches an account name case- and space-insensitively", () => {
    const plan = planSheet(
      [["date", "description", "to", "amount"], ["04/08/2026", "x", "  fOOd ", "-450"]],
      mapping({ columns: ["date", "description", "to", "amount"] }),
      ctx()
    );
    expect(plan.entries[0].toAccountId).toBe("a2");
  });

  it("fails a row naming an unknown account when minting is off", () => {
    const plan = planSheet(
      [["date", "description", "to", "amount"], ["04/08/2026", "x", "Transport", "-450"]],
      mapping({ columns: ["date", "description", "to", "amount"] }),
      ctx()
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.problems[0]).toEqual({ row: 2, message: "No account named “Transport”." });
  });

  it("mints one account for a name repeated down the column, not one per row", () => {
    const plan = planSheet(
      [["date", "description", "to", "amount"],
       ["04/08/2026", "bus", "Transport", "-50"],
       ["05/08/2026", "cab", "Transport", "-250"]],
      mapping({ columns: ["date", "description", "to", "amount"], createMissing: true }),
      ctx()
    );
    expect(plan.accounts).toEqual([
      { id: "new1", name: "Transport", kind: "expense", subtype: "general_expense" },
    ]);
    expect(plan.entries.map((e) => e.toAccountId)).toEqual(["new1", "new1"]);
  });

  it("mints a from-side name as income, not as a category", () => {
    const plan = planSheet(
      [["date", "description", "from", "amount"], ["04/08/2026", "gig", "Freelance", "5000"]],
      mapping({ columns: ["date", "description", "from", "amount"], createMissing: true }),
      ctx()
    );
    expect(plan.accounts[0]).toMatchObject({ kind: "income", subtype: "other_income" });
  });

  it("skips a row that would post an account against itself", () => {
    const plan = planSheet(
      [["date", "description", "from", "to", "amount"],
       ["04/08/2026", "x", "ICICI", "ICICI", "500"]],
      mapping({ columns: ["date", "description", "from", "to", "amount"] }),
      ctx()
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.problems[0].message).toBe("Both sides of this row are the same account.");
  });

  it("reports the bad rows and imports the rest", () => {
    const plan = planSheet(
      [["date", "description", "amount"],
       ["04/08/2026", "ok", "-450"],
       ["not a date", "bad", "-450"],
       ["05/08/2026", "no amount", ""]],
      mapping({ columns: ["date", "description", "amount"] }),
      ctx()
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.problems.map((p) => p.row)).toEqual([3, 4]);
    expect(plan.rowsRead).toBe(3);
  });

  it("spots a row already in the book and skips it by default", () => {
    const txn: Transaction = {
      id: "t1", ledger_id: "L", date: "2026-08-04", description: "Swiggy", status: "done",
      tag: null, recurring_template_id: null, reimburse_account_id: null,
      reimburse_amount_paise: null, notes: null,
    };
    const postings: Posting[] = [
      { id: "p1", transaction_id: "t1", account_id: "a1", amount_paise: -45000 },
      { id: "p2", transaction_id: "t1", account_id: "a2", amount_paise: 45000 },
    ];
    const rows = [["date", "description", "amount"], ["04/08/2026", "swiggy ", "-450"]];
    const cols = mapping({ columns: ["date", "description", "amount"] });

    const skipped = planSheet(rows, cols, ctx({ transactions: [txn], postings }));
    expect(skipped.entries).toHaveLength(0);
    expect(skipped.duplicates).toBe(1);

    const kept = planSheet(rows, { ...cols, onDuplicate: "import" }, ctx({ transactions: [txn], postings }));
    expect(kept.entries).toHaveLength(1);
    expect(kept.entries[0].duplicate).toBe(true);
  });

  it("catches a repeat inside the file itself — statements overlap at the edges", () => {
    const plan = planSheet(
      [["date", "description", "amount"],
       ["04/08/2026", "Swiggy", "-450"],
       ["04/08/2026", "Swiggy", "-450"]],
      mapping({ columns: ["date", "description", "amount"] }),
      ctx()
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.duplicates).toBe(1);
  });

  it("reads a headerless sheet from the first row", () => {
    const plan = planSheet(
      [["04/08/2026", "Swiggy", "-450"]],
      mapping({ columns: ["date", "description", "amount"], hasHeader: false }),
      ctx()
    );
    expect(plan.entries[0].row).toBe(1);
  });
});

describe("readArchive", () => {
  it("takes what exportJson wrote", () => {
    const file = exportJson({
      ledger: { id: "L", name: "B" }, accounts: [bank], transactions: [], postings: [], templates: [],
    });
    expect(readArchive(JSON.parse(file.content))).toHaveProperty("bundle");
  });

  it("names the format it actually found", () => {
    const r = readArchive({ format: "ynab" });
    expect(r).toEqual({ error: "That file is not a Munshi archive (its format is “ynab”)." });
  });

  it("rejects an array, a null and a bundle missing its tables", () => {
    expect(readArchive([])).toHaveProperty("error");
    expect(readArchive(null)).toHaveProperty("error");
    expect(readArchive({ format: "munshi.ledger" })).toEqual({
      error: "The archive is missing accounts, transactions or postings.",
    });
  });
});

describe("planRestore", () => {
  const archive = {
    format: "munshi.ledger",
    accounts: [
      { id: "old1", name: "ICICI", kind: "asset" as const, subtype: "bank" as const },
      { id: "old2", name: "Amazon Pay", kind: "liability" as const, subtype: "credit_card" as const,
        statement_day: 3, due_day: 19, credit_limit_paise: 10000000 },
    ],
    transactions: [
      { id: "t1", date: "2026-08-04", description: "Swiggy", status: "done" as const, tag: "avoidable" },
    ],
    postings: [
      { id: "p1", transaction_id: "t1", account_id: "old2", amount_paise: -45000 },
      { id: "p2", transaction_id: "t1", account_id: "old1", amount_paise: 45000 },
    ],
  };

  it("matches an account the book already has instead of duplicating it", () => {
    const plan = planRestore(archive, ctx());
    expect(plan.accounts.map((a) => a.name)).toEqual(["Amazon Pay"]);
    expect(plan.entries[0].toAccountId).toBe("a1"); // the existing ICICI
    expect(plan.entries[0].fromAccountId).toBe("new1"); // the minted card
  });

  it("never reuses the archive's ids", () => {
    const plan = planRestore(archive, ctx());
    expect(plan.accounts[0].id).toBe("new1");
    expect(plan.entries[0].fromAccountId).not.toBe("old2");
  });

  it("brings a card back with its statement day and limit", () => {
    const ops = planToOps(planRestore(archive, ctx()), "L");
    const created = ops.find((o) => o.kind === "account.create");
    expect(created).toMatchObject({
      account: { name: "Amazon Pay", statement_day: 3, due_day: 19, credit_limit_paise: 10000000 },
    });
  });

  it("reports an entry whose legs it cannot rebuild rather than half-writing it", () => {
    const plan = planRestore(
      { ...archive, postings: [{ id: "p1", transaction_id: "t1", account_id: "old1", amount_paise: -45000 }] },
      ctx()
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.problems[0].message).toContain("no legs in the archive");
  });

  it("round-trips an export back into an empty book", () => {
    const file = exportJson({
      ledger: { id: "L", name: "B" },
      accounts: [bank, food],
      transactions: [{
        id: "t1", ledger_id: "L", date: "2026-08-04", description: "Swiggy", status: "done",
        tag: null, recurring_template_id: null, reimburse_account_id: null,
        reimburse_amount_paise: null, notes: null,
      }],
      postings: [
        { id: "p1", transaction_id: "t1", account_id: "a1", amount_paise: -45000 },
        { id: "p2", transaction_id: "t1", account_id: "a2", amount_paise: 45000 },
      ],
      templates: [],
    });
    const read = readArchive(JSON.parse(file.content));
    expect(read).toHaveProperty("bundle");
    const plan = planRestore((read as { bundle: never }).bundle, ctx({ accounts: [] }));
    expect(plan.accounts.map((a) => a.name)).toEqual(["ICICI", "Food"]);
    expect(plan.entries[0]).toMatchObject({ description: "Swiggy", amountPaise: 45000 });
  });
});

describe("planToOps", () => {
  it("puts account creates first, so an entry can name one of them", () => {
    const plan = planSheet(
      [["date", "description", "to", "amount"], ["04/08/2026", "bus", "Transport", "-50"]],
      mapping({ columns: ["date", "description", "to", "amount"], createMissing: true }),
      ctx()
    );
    const ops = planToOps(plan, "L");
    expect(ops.map((o) => o.kind)).toEqual(["account.create", "entry.create"]);
  });

  it("produces a batch the ledger's own validator accepts", () => {
    const plan = planSheet(
      [["date", "description", "to", "amount"],
       ["04/08/2026", "bus", "Transport", "-50"],
       ["05/08/2026", "lunch", "Food", "-450"]],
      mapping({ columns: ["date", "description", "to", "amount"], createMissing: true }),
      ctx()
    );
    const ops = planToOps(plan, "L");
    expect(validateBatch(ops, [bank.id, food.id, salary.id])).toEqual([]);
  });

  it("builds balanced legs", () => {
    const plan = planSheet(
      [["date", "description", "amount"], ["04/08/2026", "Swiggy", "-450"]],
      mapping({ columns: ["date", "description", "amount"] }),
      ctx()
    );
    const op = planToOps(plan, "L")[0];
    if (op.kind !== "entry.create") throw new Error("expected an entry");
    expect(op.postings.reduce((s, p) => s + p.amount_paise, 0)).toBe(0);
    expect(op.ledgerId).toBe("L");
  });
});

describe("describePlan", () => {
  it("says what approving will do", () => {
    expect(describePlan({
      entries: [1, 2, 3] as never[], accounts: [1] as never[],
      problems: [1] as never[], duplicates: 2, rowsRead: 6,
    })).toBe("3 entries · 1 new account · 2 already in the book · 1 row skipped");
  });
});

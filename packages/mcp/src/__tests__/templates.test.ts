import { describe, expect, it } from "vitest";
import type { Account, RecurringTemplate, Transaction } from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import {
  proposeCardEmi,
  proposeEntry,
  proposeEntryEdit,
  proposePostRecurring,
  proposeTemplateUpdate,
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

const template = (over: Partial<RecurringTemplate> & { id: string; name: string }): RecurringTemplate => ({
  ledger_id: "l1",
  kind: "manual",
  day_of_month: 5,
  amount_paise: 100000,
  from_account_id: "bank",
  to_account_id: "home",
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
  ...over,
});

const txn = (over: Partial<Transaction> & { id: string; date: string }): Transaction => ({
  ledger_id: "l1",
  description: "x",
  status: "done",
  tag: null,
  recurring_template_id: null,
  reimburse_account_id: null,
  reimburse_amount_paise: null,
  notes: null,
  ...over,
});

const accounts = [
  account({ id: "bank", name: "ICICI" }),
  account({ id: "card", name: "Axis", kind: "liability", subtype: "credit_card", is_liquid: false }),
  account({ id: "home", name: "Home", kind: "expense", subtype: "general_expense" }),
  account({ id: "loan", name: "Exa Loan", kind: "liability", subtype: "loan", is_liquid: false }),
  account({ id: "asher", name: "Asher", subtype: "receivable", is_liquid: false }),
  account({ id: "farzan", name: "Farzan", subtype: "receivable", is_liquid: false }),
];

const rent = template({ id: "rent", name: "Rent", amount_paise: 2520000 });
// split: Asher owes half of each installment
const exa = template({
  id: "exa", name: "Exa Loan EMI", amount_paise: 1709900, to_account_id: "loan",
  reimburse_account_id: "asher", reimburse_amount_paise: 854950,
  total_installments: 36, start_date: "2025-09-05",
});
// run for Farzan, who owes all of it
const farzanEmi = template({
  id: "fz", name: "Axis EMI (Farzan)", kind: "autodebit_cc", amount_paise: 515894,
  from_account_id: "card", to_account_id: "farzan",
  reimburse_account_id: "farzan", reimburse_amount_paise: 515894,
});

const snapshot: LedgerSnapshot = {
  accounts,
  transactions: [txn({ id: "sep-rent", date: "2026-09-03", description: "Rent", recurring_template_id: "rent" })],
  postings: [
    { id: "p1", transaction_id: "sep-rent", account_id: "bank", amount_paise: -2520000 },
    { id: "p2", transaction_id: "sep-rent", account_id: "home", amount_paise: 2520000 },
  ],
  templates: [rent, exa, farzanEmi],
};

const entryOf = (op: ReturnType<typeof proposePostRecurring>) => {
  const e = op.ops[0];
  if (e.kind !== "entry.create") throw new Error("expected an entry");
  return e;
};

describe("proposePostRecurring", () => {
  it("links the entry to its template, named and routed like the post button", () => {
    const e = entryOf(proposePostRecurring(snapshot, { ledgerId: "l1", templateId: "rent", date: "2026-10-04" }));
    expect(e.txn.recurringTemplateId).toBe("rent");
    expect(e.txn.description).toBe("Rent");
    expect(e.postings).toEqual([
      { account_id: "bank", amount_paise: -2520000 },
      { account_id: "home", amount_paise: 2520000 },
    ]);
  });

  it("refuses a second posting in the same month unless told", () => {
    expect(() =>
      proposePostRecurring(snapshot, { ledgerId: "l1", templateId: "rent", date: "2026-09-20" })
    ).toThrow(/already posted for 2026-09/);
    const op = proposePostRecurring(snapshot, {
      ledgerId: "l1", templateId: "rent", date: "2026-09-20", allowDuplicate: true,
    });
    expect(op.preview.warnings.join(" ")).toContain("second");
  });

  it("carries the template's split, and lets the share be overridden", () => {
    const e = entryOf(proposePostRecurring(snapshot, { ledgerId: "l1", templateId: "exa", date: "2026-10-05" }));
    expect(e.postings).toContainEqual({ account_id: "asher", amount_paise: 854950 });
    const o = entryOf(proposePostRecurring(snapshot, {
      ledgerId: "l1", templateId: "exa", date: "2026-10-05", reimbursePaise: 855000,
    }));
    expect(o.postings).toEqual([
      { account_id: "bank", amount_paise: -1709900 },
      { account_id: "loan", amount_paise: 854900 },
      { account_id: "asher", amount_paise: 855000 },
    ]);
  });

  it("keeps someone owing the whole of it when the bill changes", () => {
    const e = entryOf(proposePostRecurring(snapshot, {
      ledgerId: "l1", templateId: "fz", date: "2026-10-02", amountPaise: 513788,
    }));
    expect(e.txn.reimbursePaise).toBe(513788);
    expect(e.postings).toEqual([
      { account_id: "card", amount_paise: -513788 },
      { account_id: "farzan", amount_paise: 513788 },
    ]);
  });

  it("says when the amount differs from the plan", () => {
    const op = proposePostRecurring(snapshot, {
      ledgerId: "l1", templateId: "rent", date: "2026-10-04", amountPaise: 2600000,
    });
    expect(op.preview.warnings.join(" ")).toContain("propose_template_update");
  });
});

describe("proposeTemplateUpdate", () => {
  it("patches only what was given", () => {
    const op = proposeTemplateUpdate(snapshot, { templateId: "rent", amountPaise: 2600000, dayOfMonth: 4 });
    expect(op.ops).toEqual([
      { kind: "template.update", current: rent, patch: { amount_paise: 2600000, day_of_month: 4 } },
    ]);
  });

  it("moves an owed-in-full share along with the amount", () => {
    const op = proposeTemplateUpdate(snapshot, { templateId: "fz", amountPaise: 513788 });
    const u = op.ops[0];
    expect(u.kind === "template.update" && u.patch.reimburse_amount_paise).toBe(513788);
  });

  it("refuses an empty change", () => {
    expect(() => proposeTemplateUpdate(snapshot, { templateId: "rent" })).toThrow(/Nothing to change/);
  });
});

describe("entries and templates", () => {
  it("lets propose_entry link a template and post an owed-in-full EMI", () => {
    const op = proposeEntry(snapshot, {
      ledgerId: "l1", date: "2026-10-02", description: "Axis EMI (Farzan)", status: "done",
      fromAccountId: "card", toAccountId: "farzan", amountPaise: 513788,
      reimburseAccountId: "farzan", reimbursePaise: 513788, recurringTemplateId: "fz",
    });
    const e = op.ops[0];
    expect(e.kind === "entry.create" && e.txn.recurringTemplateId).toBe("fz");
  });

  it("keeps a split the edit does not mention", () => {
    const withSplit: LedgerSnapshot = {
      ...snapshot,
      transactions: [
        txn({ id: "t-exa", date: "2026-09-05", description: "Exa Loan EMI", recurring_template_id: "exa",
          reimburse_account_id: "asher", reimburse_amount_paise: 854950 }),
      ],
      postings: [],
    };
    const op = proposeEntryEdit(withSplit, "t-exa", {
      date: "2026-09-06", description: "Exa Loan EMI", status: "done",
      fromAccountId: "bank", toAccountId: "loan", amountPaise: 1709900,
    });
    const e = op.ops[0];
    expect(e.kind === "entry.rewrite" && e.postings).toContainEqual({ account_id: "asher", amount_paise: 854950 });
    // null removes it
    const cleared = proposeEntryEdit(withSplit, "t-exa", {
      date: "2026-09-06", description: "Exa Loan EMI", status: "done",
      fromAccountId: "bank", toAccountId: "loan", amountPaise: 1709900,
      reimburseAccountId: null, reimbursePaise: null,
    }).ops[0];
    expect(cleared.kind === "entry.rewrite" && cleared.postings).toHaveLength(2);
  });
});

describe("proposeCardEmi with a real installment", () => {
  it("bills what the bank bills and posts the first one linked", () => {
    const op = proposeCardEmi(snapshot, {
      ledgerId: "l1", cardId: "card", expenseAccountId: "home", description: "Monitor",
      totalPaise: 2947200, months: 9, installmentPaise: 351100, firstBillingISO: "2026-10-23",
      postFirstInstallment: true, processingFeePaise: 35282, feeDateISO: "2026-10-23",
      today: "2026-10-30",
    }, () => "tpl-1");
    expect(op.ops.map((o) => o.kind)).toEqual(["template.create", "entry.create", "entry.create"]);
    const [tpl, first, fee] = op.ops;
    expect(tpl.kind === "template.create" && tpl.template.amount_paise).toBe(351100);
    expect(first.kind === "entry.create" && first.txn.recurringTemplateId).toBe("tpl-1");
    expect(fee.kind === "entry.create" && fee.txn.date).toBe("2026-10-23");
    expect(op.preview.warnings.join(" ")).not.toContain("divide evenly");
  });
});

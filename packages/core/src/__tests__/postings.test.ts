import { describe, expect, it } from "vitest";
import { buildPostings, type EntryInput } from "@munshi/core";

function entry(patch: Partial<EntryInput>): EntryInput {
  return {
    ledgerId: "l1",
    date: "2026-08-01",
    description: "Test",
    status: "done",
    fromAccountId: "from",
    toAccountId: "to",
    amountPaise: 10000,
    ...patch,
  };
}

const sum = (rows: { amount_paise: number }[]) =>
  rows.reduce((s, r) => s + r.amount_paise, 0);

describe("buildPostings", () => {
  it("builds a two-leg entry: from credited, to debited", () => {
    const rows = buildPostings(entry({}));
    expect(rows).toEqual([
      { account_id: "from", amount_paise: -10000 },
      { account_id: "to", amount_paise: 10000 },
    ]);
  });

  it("splits into three legs when someone owes part", () => {
    const rows = buildPostings(entry({ reimburseAccountId: "person", reimbursePaise: 4000 })
    );
    expect(rows).toEqual([
      { account_id: "from", amount_paise: -10000 },
      { account_id: "to", amount_paise: 6000 },
      { account_id: "person", amount_paise: 4000 },
    ]);
  });

  it("clamps the reimbursement to the entry amount", () => {
    const rows = buildPostings(entry({ reimburseAccountId: "person", reimbursePaise: 99999 })
    );
    // full amount goes to the person, own share drops out entirely
    expect(rows).toEqual([
      { account_id: "from", amount_paise: -10000 },
      { account_id: "person", amount_paise: 10000 },
    ]);
  });

  it("ignores a zero or negative reimbursement", () => {
    expect(buildPostings(entry({ reimburseAccountId: "p", reimbursePaise: 0 }))).toHaveLength(2);
    expect(buildPostings(entry({ reimburseAccountId: "p", reimbursePaise: -5 }))).toHaveLength(2);
  });

  it("ignores a reimbursement amount without a person", () => {
    const rows = buildPostings(entry({ reimbursePaise: 4000 }));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ account_id: "to", amount_paise: 10000 });
  });

  it("always balances to zero", () => {
    const cases: Partial<EntryInput>[] = [
      {},
      { amountPaise: 1 },
      { amountPaise: 999999999 },
      { reimburseAccountId: "p", reimbursePaise: 1 },
      { reimburseAccountId: "p", reimbursePaise: 9999 },
      { reimburseAccountId: "p", reimbursePaise: 10000 },
      { reimburseAccountId: "p", reimbursePaise: 10001 },
    ];
    for (const c of cases) {
      expect(sum(buildPostings(entry(c)))).toBe(0);
    }
  });

  it("never emits a zero-amount leg (the DB forbids them)", () => {
    // own share becomes 0 when the person owes everything
    const rows = buildPostings(entry({ reimburseAccountId: "p", reimbursePaise: 10000 })
    );
    expect(rows.every((r) => r.amount_paise !== 0)).toBe(true);
  });
});

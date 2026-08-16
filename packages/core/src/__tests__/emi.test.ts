import { describe, expect, it } from "vitest";
import { amortize, emiActive, emiInfo, fmtMonth } from "@munshi/core";
import type { RecurringTemplate } from "@munshi/core";

function tpl(patch: Partial<RecurringTemplate>): RecurringTemplate {
  return {
    ledger_id: "l1",
    id: "t1",
    name: "EMI",
    kind: "autodebit_cc",
    day_of_month: 5,
    amount_paise: 100000,
    from_account_id: "card",
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

describe("emiInfo", () => {
  it("is null without total installments", () => {
    expect(emiInfo(tpl({ start_date: "2026-01-05" }), "2026-03")).toBeNull();
  });

  it("is null without a start date", () => {
    expect(emiInfo(tpl({ total_installments: 12 }), "2026-03")).toBeNull();
  });

  it("indexes installments 1-based from the start month", () => {
    const t = tpl({ total_installments: 12, start_date: "2026-01-05" });
    expect(emiInfo(t, "2026-01")?.idx).toBe(1);
    expect(emiInfo(t, "2026-02")?.idx).toBe(2);
    expect(emiInfo(t, "2026-12")?.idx).toBe(12);
  });

  it("crosses year boundaries", () => {
    const t = tpl({ total_installments: 24, start_date: "2025-11-05" });
    expect(emiInfo(t, "2026-01")?.idx).toBe(3);
    expect(emiInfo(t, "2027-10")?.idx).toBe(24);
  });

  it("goes below 1 before start and above total after end", () => {
    const t = tpl({ total_installments: 3, start_date: "2026-06-05" });
    expect(emiInfo(t, "2026-05")?.idx).toBe(0);
    expect(emiInfo(t, "2026-09")?.idx).toBe(4);
  });

  it("computes the end date total−1 months after start", () => {
    const t = tpl({ total_installments: 12, start_date: "2026-01-05" });
    expect(emiInfo(t, "2026-01")?.endISO).toBe("2026-12-05");
  });

  it("clamps the end day in short months", () => {
    // start on the 31st; 2 installments → ends in Feb (28 days in 2026)
    const t = tpl({ total_installments: 2, start_date: "2026-01-31" });
    expect(emiInfo(t, "2026-01")?.endISO).toBe("2026-02-28");
  });

  it("keeps the start day when the end month is long enough", () => {
    const t = tpl({ total_installments: 4, start_date: "2026-01-31" });
    // Jan → Apr: Apr has 30 days
    expect(emiInfo(t, "2026-01")?.endISO).toBe("2026-04-30");
  });

  it("exposes total and startISO unchanged", () => {
    const t = tpl({ total_installments: 7, start_date: "2026-04-03" });
    const e = emiInfo(t, "2026-04")!;
    expect(e.total).toBe(7);
    expect(e.startISO).toBe("2026-04-03");
  });
});

describe("emiActive", () => {
  it("is always true for non-EMI templates", () => {
    expect(emiActive(tpl({}), "2026-01")).toBe(true);
    expect(emiActive(tpl({}), "2099-12")).toBe(true);
  });

  it("is true exactly within [start month, end month]", () => {
    const t = tpl({ total_installments: 3, start_date: "2026-06-05" });
    expect(emiActive(t, "2026-05")).toBe(false); // before start
    expect(emiActive(t, "2026-06")).toBe(true); // first
    expect(emiActive(t, "2026-07")).toBe(true); // middle
    expect(emiActive(t, "2026-08")).toBe(true); // last
    expect(emiActive(t, "2026-09")).toBe(false); // after end
  });

  it("handles a single-installment EMI", () => {
    const t = tpl({ total_installments: 1, start_date: "2026-06-05" });
    expect(emiActive(t, "2026-05")).toBe(false);
    expect(emiActive(t, "2026-06")).toBe(true);
    expect(emiActive(t, "2026-07")).toBe(false);
  });
});

describe("fmtMonth", () => {
  it("formats a month as short-month + year", () => {
    expect(fmtMonth("2026-11-05")).toMatch(/Nov.*2026/);
    expect(fmtMonth("2026-01")).toMatch(/Jan.*2026/);
  });
});

describe("amortize", () => {
  const loan = amortize(10000000, 10, 12, "2026-09-05"); // ₹1L, 10% p.a., 12m

  it("clears the principal exactly", () => {
    expect(loan.rows.at(-1)!.outstandingPaise).toBe(0);
    expect(loan.rows.reduce((s, r) => s + r.principalPaise, 0)).toBe(10000000);
  });

  it("charges interest on the reducing balance", () => {
    expect(loan.rows[0].interestPaise).toBe(83333); // 1L × 10%/12
    expect(loan.rows[0].interestPaise).toBeGreaterThan(loan.rows[11].interestPaise);
  });

  it("keeps every installment but the last identical", () => {
    const middle = new Set(loan.rows.slice(0, 11).map((r) => r.emiPaise));
    expect(middle.size).toBe(1);
    expect(loan.emiPaise).toBe(879159);
  });

  it("adds up", () => {
    expect(loan.totalPaidPaise).toBe(loan.totalInterestPaise + 10000000);
  });

  it("walks the due dates a month at a time, clamping short months", () => {
    expect(loan.rows[0].dateISO).toBe("2026-09-05");
    expect(loan.rows[11].dateISO).toBe("2027-08-05");
    expect(amortize(120000, 0, 3, "2026-01-31").rows.map((r) => r.dateISO)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
  });

  it("handles an interest-free loan without dividing by zero", () => {
    const free = amortize(120000, 0, 3, "2026-09-01");
    expect(free.emiPaise).toBe(40000);
    expect(free.totalInterestPaise).toBe(0);
    expect(free.rows.at(-1)!.outstandingPaise).toBe(0);
  });

  it("refuses a loan with no installments", () => {
    expect(() => amortize(1000, 10, 0, "2026-09-01")).toThrow(/at least one/);
  });
});

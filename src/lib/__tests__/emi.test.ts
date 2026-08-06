import { describe, expect, it } from "vitest";
import { emiActive, emiInfo, fmtMonth } from "@/lib/emi";
import type { RecurringTemplate } from "@/lib/types";

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

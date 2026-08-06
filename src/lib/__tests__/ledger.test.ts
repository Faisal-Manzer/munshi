import { describe, expect, it } from "vitest";
import {
  availableBalance,
  childrenOf,
  displayBalance,
  isCard,
  isParentCard,
  nextOccurrence,
  stripTime,
  subtreeBalance,
  toISODate,
} from "@/lib/ledger";
import type { Account, AccountBalance } from "@/lib/types";

function acc(patch: Partial<Account>): Account {
  return {
    ledger_id: "l1",
    id: "a1",
    user_id: "u1",
    name: "Account",
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

function balMap(entries: [string, number, number?, number?][]): Map<string, AccountBalance> {
  return new Map(
    entries.map(([id, balance, settled, pending]) => [
      id,
      {
        account_id: id,
        balance_paise: balance,
        settled_paise: settled ?? balance,
        pending_paise: pending ?? 0,
      },
    ])
  );
}

describe("displayBalance", () => {
  it("keeps assets and expenses as-is", () => {
    expect(displayBalance(acc({ kind: "asset" }), 5000)).toBe(5000);
    expect(displayBalance(acc({ kind: "expense" }), 5000)).toBe(5000);
    expect(displayBalance(acc({ kind: "equity" }), -5000)).toBe(-5000);
  });

  it("flips liabilities and income so owed/earned read positive", () => {
    expect(displayBalance(acc({ kind: "liability" }), -30000)).toBe(30000);
    expect(displayBalance(acc({ kind: "income" }), -1679370)).toBe(1679370);
  });
});

describe("childrenOf", () => {
  it("returns direct, unarchived children only", () => {
    const bank = acc({ id: "bank" });
    const env1 = acc({ id: "e1", parent_id: "bank", subtype: "envelope" });
    const envArchived = acc({ id: "e2", parent_id: "bank", subtype: "envelope", archived: true });
    const other = acc({ id: "x" });
    expect(childrenOf([bank, env1, envArchived, other], "bank").map((a) => a.id)).toEqual(["e1"]);
  });
});

describe("subtreeBalance", () => {
  const bank = acc({ id: "bank" });
  const env = acc({ id: "env", parent_id: "bank", subtype: "envelope" });
  const grand = acc({ id: "grand", parent_id: "env", subtype: "envelope" });
  const accounts = [bank, env, grand];

  it("sums the account and all descendants recursively", () => {
    const balances = balMap([
      ["bank", 100000],
      ["env", 25000],
      ["grand", 5000],
    ]);
    expect(subtreeBalance(accounts, balances, "bank")).toBe(130000);
    expect(subtreeBalance(accounts, balances, "env")).toBe(30000);
    expect(subtreeBalance(accounts, balances, "grand")).toBe(5000);
  });

  it("treats missing balances as zero", () => {
    expect(subtreeBalance(accounts, balMap([["env", 7]]), "bank")).toBe(7);
  });

  it("supports settled and pending fields", () => {
    const balances = balMap([
      ["bank", 100, 80, 20],
      ["env", 50, 50, 0],
    ]);
    expect(subtreeBalance(accounts, balances, "bank", "settled_paise")).toBe(130);
    expect(subtreeBalance(accounts, balances, "bank", "pending_paise")).toBe(20);
  });
});

describe("availableBalance", () => {
  it("splits total into set-aside (envelopes) and free money", () => {
    const bank = acc({ id: "bank" });
    const env = acc({ id: "env", parent_id: "bank", subtype: "envelope" });
    const balances = balMap([
      ["bank", 100000],
      ["env", 25000],
    ]);
    expect(availableBalance([bank, env], balances, "bank")).toEqual({
      total: 125000,
      setAside: 25000,
      available: 100000,
    });
  });
});

describe("isCard / isParentCard", () => {
  const parent = acc({ id: "p", kind: "liability", subtype: "credit_card" });
  const sub = acc({ id: "s", kind: "liability", subtype: "credit_card", parent_id: "p" });
  const bank = acc({ id: "b" });

  it("identifies cards by subtype", () => {
    expect(isCard(parent)).toBe(true);
    expect(isCard(sub)).toBe(true);
    expect(isCard(bank)).toBe(false);
  });

  it("parent card = card without a parent", () => {
    expect(isParentCard([parent, sub], parent)).toBe(true);
    expect(isParentCard([parent, sub], sub)).toBe(false);
    expect(isParentCard([parent, sub], bank)).toBe(false);
  });
});

describe("nextOccurrence", () => {
  it("returns this month's date when still ahead (or today)", () => {
    expect(toISODate(nextOccurrence(15, new Date(2026, 7, 1)))).toBe("2026-08-15");
    expect(toISODate(nextOccurrence(1, new Date(2026, 7, 1)))).toBe("2026-08-01");
  });

  it("rolls to next month when the day has passed", () => {
    expect(toISODate(nextOccurrence(5, new Date(2026, 7, 10)))).toBe("2026-09-05");
  });

  it("clamps day 29–31 to month end", () => {
    expect(toISODate(nextOccurrence(31, new Date(2026, 1, 10)))).toBe("2026-02-28");
    expect(toISODate(nextOccurrence(31, new Date(2026, 3, 10)))).toBe("2026-04-30");
  });

  it("respects leap years", () => {
    expect(toISODate(nextOccurrence(30, new Date(2024, 1, 10)))).toBe("2024-02-29");
    expect(toISODate(nextOccurrence(30, new Date(2025, 1, 10)))).toBe("2025-02-28");
  });

  it("rolls a clamped date that already passed into the next month", () => {
    // day 31 on 28 Feb 2026: Feb's clamped date is today → returned (>= from)
    expect(toISODate(nextOccurrence(31, new Date(2026, 1, 28)))).toBe("2026-02-28");
  });
});

describe("stripTime / toISODate", () => {
  it("strips the time part", () => {
    const d = stripTime(new Date(2026, 7, 1, 17, 45, 12));
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
    expect(toISODate(d)).toBe("2026-08-01");
  });

  it("zero-pads month and day", () => {
    expect(toISODate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(toISODate(new Date(2026, 10, 25))).toBe("2026-11-25");
  });
});

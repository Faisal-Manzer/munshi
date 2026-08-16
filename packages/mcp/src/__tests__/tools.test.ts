import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@munshi/crypto";
import type { Account, LedgerOp, LedgerStore, OpResult } from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import { registerTools, type CallerAuth, type CommitLog, type McpContext } from "@munshi/mcp";

/**
 * The whole loop, without a database: register the tools against a fake
 * server, call them the way a client would, and check that a proposal only
 * becomes rows when it is committed.
 */
type Handler = (args: unknown, extra: { authInfo?: CallerAuth }) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

const bank: Account = {
  id: "bank",
  user_id: "u1",
  ledger_id: "l1",
  name: "ICICI main",
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
};
const food: Account = { ...bank, id: "food", name: "Food", kind: "expense", subtype: "general_expense" };

function world() {
  const snapshot: LedgerSnapshot = {
    accounts: [bank, food],
    transactions: [
      { id: "t0", ledger_id: "l1", date: "2026-08-01", description: "Opening", status: "done", tag: null, recurring_template_id: null, reimburse_account_id: null, reimburse_amount_paise: null, notes: null },
    ],
    postings: [
      { id: "p0", transaction_id: "t0", account_id: "bank", amount_paise: 24000000 },
      { id: "p1", transaction_id: "t0", account_id: "food", amount_paise: -24000000 },
    ],
    templates: [],
  };
  const written: LedgerOp[] = [];
  const store = {
    async applyAll(ops: LedgerOp[]): Promise<OpResult[]> {
      written.push(...ops);
      return ops.map((o) => ({ kind: o.kind, id: "row-1" }));
    },
  } as unknown as LedgerStore;

  const committed = new Set<string>();
  const log: CommitLog = {
    async find(_userId, hash) {
      return committed.has(hash) ? { committedAt: "2026-08-17T09:00:00.000Z" } : null;
    },
    async record(entry) {
      committed.add(entry.proposalHash);
    },
  };

  const serverKeys = generateKeyPair();
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: never, handler: never) {
      tools.set(name, handler as unknown as Handler);
    },
  };

  const context = (ledgerId: string | null): McpContext => ({
    userId: "u1",
    ledgerId,
    listLedgers: async () => [{ id: "l1", name: "Personal" }],
    snapshot: async () => snapshot,
    commitContext: async () => ({
      userId: "u1",
      ledgerId: "l1",
      store,
      snapshot,
      log,
      nowSeconds: 1_770_000_000,
    }),
    log,
    serverKeys,
    nowSeconds: 1_770_000_000,
    today: "2026-08-17",
    nowISO: "2026-08-17T09:00:00.000Z",
  });

  registerTools(server, async (auth) =>
    context((auth?.extra?.ledgerId as string | undefined) ?? null)
  );

  const call = async (name: string, args: unknown, ledgerId: string | null = "l1") => {
    const handler = tools.get(name);
    if (!handler) throw new Error(`no tool ${name}`);
    return handler(args, { authInfo: { extra: { ledgerId } } });
  };

  return { call, written, tools };
}

const chai = {
  date: "2026-08-17",
  description: "Chai",
  from_account_id: "bank",
  to_account_id: "food",
  amount_paise: 4000,
  status: "done",
};

/** The proposal id is the last line of the tool's text. */
const idFrom = (text: string) => text.trim().split("\n").pop()!.trim();

describe("the tool loop", () => {
  it("registers reads, proposals and exactly one committing tool", () => {
    const { tools } = world();
    expect(tools.has("list_accounts")).toBe(true);
    expect(tools.has("propose_entry")).toBe(true);
    expect([...tools.keys()].filter((k) => k.startsWith("commit"))).toEqual(["commit_proposal"]);
  });

  it("previews without writing, then writes on commit", async () => {
    const { call, written } = world();

    const proposed = await call("propose_entry", chai);
    const text = proposed.content[0].text;
    expect(text).toContain("Cr  ICICI main");
    expect(text).toContain("₹2,40,000.00");
    expect(text).toContain("Nothing has been written yet");
    expect(written).toHaveLength(0);

    const committed = await call("commit_proposal", { proposal_id: idFrom(text) });
    expect(committed.isError).toBeUndefined();
    expect(committed.content[0].text).toContain("Written.");
    expect(written.map((o) => o.kind)).toEqual(["entry.create"]);
  });

  it("writes once when the same proposal is committed twice", async () => {
    const { call, written } = world();
    const id = idFrom((await call("propose_entry", chai)).content[0].text);
    await call("commit_proposal", { proposal_id: id });
    const again = await call("commit_proposal", { proposal_id: id });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain("ALREADY_COMMITTED");
    expect(written).toHaveLength(1);
  });

  it("refuses a proposal id the server did not seal", async () => {
    const { call, written } = world();
    const forged = await call("commit_proposal", { proposal_id: "mp1.deadbeef" });
    expect(forged.isError).toBe(true);
    expect(forged.content[0].text).toContain("BAD_PROPOSAL");
    expect(written).toHaveLength(0);
  });

  it("asks for a ledger before doing anything, and lists the options", async () => {
    const { call } = world();
    const result = await call("propose_entry", chai, null);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("NO_LEDGER");
    expect(result.content[0].text).toContain("Personal");
  });

  it("returns a refusal as readable text, not as a transport error", async () => {
    const { call } = world();
    const dup = await call("propose_entry", { ...chai, date: "2026-08-01", description: "Opening" });
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toContain("LIKELY_DUPLICATE");
  });

  it("reads balances without prompting for anything", async () => {
    const { call } = world();
    const accounts = await call("list_accounts", {});
    expect(accounts.content[0].text).toContain("ICICI main");
    expect(accounts.content[0].text).toContain("₹2,40,000.00");
  });
});

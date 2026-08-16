import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@munshi/crypto";
import type { Account, LedgerOp, LedgerStore, OpResult } from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";
import {
  commitProposal,
  proposeReconcile,
  sealProposal,
  touchedAccountIds,
  type CommitLog,
} from "@munshi/mcp";
import { balanceFingerprint, deriveView } from "@munshi/store";

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

function fakeStore() {
  const applied: LedgerOp[][] = [];
  const store = {
    async applyAll(ops: LedgerOp[]): Promise<OpResult[]> {
      applied.push(ops);
      return ops.map((o, i) => ({ kind: o.kind, id: `row-${i}` }));
    },
  } as unknown as LedgerStore;
  return { store, applied };
}

function fakeLog() {
  const rows: { userId: string; proposalHash: string }[] = [];
  const log: CommitLog = {
    async find(userId, proposalHash) {
      return rows.some((r) => r.userId === userId && r.proposalHash === proposalHash)
        ? { committedAt: "2026-08-17T09:00:00.000Z" }
        : null;
    },
    async record(entry) {
      rows.push({ userId: entry.userId, proposalHash: entry.proposalHash });
    },
  };
  return { log, rows };
}

const NOW = 1_770_000_000;
let n = 0;

function proposal(keys: { publicKey: string }, snap = snapshot) {
  const op = proposeReconcile(
    snap,
    {
      ledgerId: "l1",
      accountId: "bank",
      realBalancePaise: 23840000,
      today: "2026-08-17",
      nowISO: "2026-08-17T09:00:00.000Z",
    },
    () => `minted-${++n}`
  );
  const accountIds = touchedAccountIds(op.ops);
  return sealProposal(
    keys.publicKey,
    {
      userId: "u1",
      ledgerId: "l1",
      ops: op.ops,
      accountIds,
      fingerprint: balanceFingerprint(deriveView(snap).balances, accountIds),
      summary: op.summary,
    },
    NOW
  );
}

function context(over: Partial<Parameters<typeof commitProposal>[1]> = {}) {
  const keys = generateKeyPair();
  const { store, applied } = fakeStore();
  const { log } = fakeLog();
  return {
    keys,
    applied,
    ctx: {
      userId: "u1",
      ledgerId: "l1",
      store,
      snapshot,
      log,
      nowSeconds: NOW + 10,
      serverKeys: keys,
      ...over,
    },
  };
}

describe("commitProposal", () => {
  it("applies exactly the ops that were sealed", async () => {
    const { keys, ctx, applied } = context();
    const token = proposal(keys);
    const receipt = await commitProposal(token, ctx);
    expect(applied).toHaveLength(1);
    expect(applied[0].map((o) => o.kind)).toEqual([
      "account.create",
      "entry.create",
      "account.update",
    ]);
    expect(receipt.summary).toContain("Reconcile ICICI main");
  });

  it("writes once when the same id is offered twice", async () => {
    const { keys, ctx, applied } = context();
    const token = proposal(keys);
    await commitProposal(token, ctx);
    await expect(commitProposal(token, ctx)).rejects.toThrow(/already committed/);
    expect(applied).toHaveLength(1);
  });

  it("refuses a proposal from another session", async () => {
    const { keys, ctx } = context();
    const token = proposal(keys);
    await expect(commitProposal(token, { ...ctx, userId: "u2" })).rejects.toThrow(
      /does not belong to this session/
    );
    await expect(commitProposal(token, { ...ctx, ledgerId: "l2" })).rejects.toThrow(
      /does not belong to this session/
    );
  });

  it("refuses once the book has moved under the preview", async () => {
    const { keys, ctx, applied } = context();
    const token = proposal(keys);
    // another device spent ₹500 from the same account in the meantime
    const moved: LedgerSnapshot = {
      ...snapshot,
      transactions: [
        ...snapshot.transactions,
        { id: "t1", ledger_id: "l1", date: "2026-08-17", description: "Elsewhere", status: "done", tag: null, recurring_template_id: null, reimburse_account_id: null, reimburse_amount_paise: null, notes: null },
      ],
      postings: [
        ...snapshot.postings,
        { id: "p2", transaction_id: "t1", account_id: "bank", amount_paise: -50000 },
        { id: "p3", transaction_id: "t1", account_id: "food", amount_paise: 50000 },
      ],
    };
    await expect(commitProposal(token, { ...ctx, snapshot: moved })).rejects.toThrow(
      /ledger changed/
    );
    expect(applied).toHaveLength(0);
  });

  it("refuses an expired proposal", async () => {
    const { keys, ctx } = context();
    const token = proposal(keys);
    await expect(
      commitProposal(token, { ...ctx, nowSeconds: NOW + 16 * 60 })
    ).rejects.toThrow(/expired/);
  });

  it("refuses a proposal sealed to a different server key", async () => {
    const { ctx } = context();
    const token = proposal(generateKeyPair());
    await expect(commitProposal(token, ctx)).rejects.toThrow(/could not be opened/);
  });
});

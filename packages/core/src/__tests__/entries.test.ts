import { describe, expect, it } from "vitest";
import {
  createEntry,
  entryCreateOp,
  postEquityAdjustment,
  rewriteEntry,
  type Account,
  type AccountSpec,
  type EntryOp,
  type LedgerStore,
} from "@munshi/core";

/** Records what the mutation API hands to storage, so the op shape is testable
 *  without a database — the same seam an encrypted oplog will occupy. */
function fakeStore() {
  // this suite only exercises the entry path, so the recorder is typed to it
  const ops: EntryOp[] = [];
  const ensured: AccountSpec[] = [];
  const store: LedgerStore = {
    async apply(op) {
      ops.push(op);
      return op.kind === "entry.create" ? `txn-${ops.length}` : op.transactionId;
    },
    async applyAll(batch) {
      ops.push(...(batch as EntryOp[]));
      return batch.map((op) => ({ kind: op.kind, id: null }));
    },
    async ensureAccount(spec) {
      ensured.push(spec);
      return { id: "equity-1", name: spec.name } as Account;
    },
    // this suite exercises the entry path only; the row mutations are
    // covered against the real driver shape in the app's codec tests
    createAccount: async (a) => ({ id: "acc-1", ...a }) as Account,
    updateAccount: async () => {},
    createTemplate: async () => "tpl-1",
    updateTemplate: async () => {},
    patchTransaction: async () => {},
    deleteTransaction: async () => {},
  };
  return { store, ops, ensured };
}

const entry = {
  ledgerId: "l1",
  date: "2026-08-01",
  description: "Chai",
  status: "done" as const,
  fromAccountId: "bank",
  toAccountId: "spends",
  amountPaise: 47900,
};

const sum = (rows: { amount_paise: number }[]) =>
  rows.reduce((s, r) => s + r.amount_paise, 0);

describe("mutation API", () => {
  it("createEntry hands storage one balanced op and returns the new id", async () => {
    const { store, ops } = fakeStore();
    const id = await createEntry(store, entry);
    expect(id).toBe("txn-1");
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("entry.create");
    expect(sum(ops[0].postings)).toBe(0);
  });

  it("carries the transaction fields storage needs, nulling what is unset", () => {
    const op = entryCreateOp({ ...entry, tag: "avoidable" });
    expect(op.txn).toMatchObject({
      date: "2026-08-01",
      description: "Chai",
      status: "done",
      tag: "avoidable",
      notes: null,
      reimburseAccountId: null,
      reimbursePaise: null,
    });
  });

  it("rewriteEntry replaces the legs wholesale under the same id", async () => {
    const { store, ops } = fakeStore();
    const id = await rewriteEntry(store, "txn-9", { ...entry, amountPaise: 500 });
    expect(id).toBe("txn-9");
    expect(ops[0]).toMatchObject({ kind: "entry.rewrite", transactionId: "txn-9" });
    expect(sum(ops[0].postings)).toBe(0);
  });

  it("a split entry still balances through the op", async () => {
    const { store, ops } = fakeStore();
    await createEntry(store, {
      ...entry,
      reimburseAccountId: "faraz",
      reimbursePaise: 20000,
    });
    expect(ops[0].postings).toHaveLength(3);
    expect(sum(ops[0].postings)).toBe(0);
  });

  it("postEquityAdjustment conjures the equity account and posts both legs", async () => {
    const { store, ops, ensured } = fakeStore();
    await postEquityAdjustment(store, "l1", "loan-1", -140000, "Outstanding set", "2026-08-09");
    expect(ensured[0]).toMatchObject({ ledgerId: "l1", subtype: "opening_balance" });
    expect(ops[0].postings).toEqual([
      { account_id: "loan-1", amount_paise: -140000 },
      { account_id: "equity-1", amount_paise: 140000 },
    ]);
  });

  it("postEquityAdjustment writes nothing when the books already match", async () => {
    const { store, ops, ensured } = fakeStore();
    const id = await postEquityAdjustment(store, "l1", "loan-1", 0, "noop", "2026-08-09");
    expect(id).toBeNull();
    expect(ops).toHaveLength(0);
    expect(ensured).toHaveLength(0);
  });
});

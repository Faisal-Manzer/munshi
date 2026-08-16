import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@munshi/crypto";
import { entryCreateOp } from "@munshi/core";
import {
  MAX_PROPOSAL_BYTES,
  assertFresh,
  openProposal,
  proposalHash,
  sealProposal,
  shortHandle,
  type NewProposal,
} from "@munshi/mcp";

const NOW = 1_770_000_000;

const ops = [
  entryCreateOp({
    ledgerId: "l1",
    date: "2026-09-01",
    description: "Chai",
    status: "done",
    fromAccountId: "bank",
    toAccountId: "food",
    amountPaise: 4000,
  }),
];

const draft: NewProposal = {
  userId: "u1",
  ledgerId: "l1",
  ops,
  accountIds: ["bank", "food"],
  fingerprint: "bank:240000:0|food:0:0",
  summary: "Chai ₹40",
};

describe("sealProposal / openProposal", () => {
  it("round-trips the ops that were previewed", () => {
    const pair = generateKeyPair();
    const token = sealProposal(pair.publicKey, draft, NOW);
    const opened = openProposal(pair, token, NOW + 60);
    expect(opened.ops).toEqual(ops);
    expect(opened.summary).toBe("Chai ₹40");
    expect(opened.exp).toBe(NOW + 15 * 60);
  });

  it("cannot be opened by anyone but the server", () => {
    const server = generateKeyPair();
    const other = generateKeyPair();
    const token = sealProposal(server.publicKey, draft, NOW);
    expect(() => openProposal(other, token, NOW)).toThrow(/could not be opened/);
  });

  it("rejects a hand-crafted proposal id", () => {
    const pair = generateKeyPair();
    expect(() => openProposal(pair, "mp1.notreallysealed", NOW)).toThrow(
      /could not be opened/
    );
    expect(() => openProposal(pair, "p_8f21", NOW)).toThrow(/Not a proposal id/);
  });

  it("expires", () => {
    const pair = generateKeyPair();
    const token = sealProposal(pair.publicKey, draft, NOW, 900);
    expect(() => openProposal(pair, token, NOW + 901)).toThrow(/expired/);
  });

  it("refuses a batch too large to carry", () => {
    const pair = generateKeyPair();
    const fat = { ...draft, summary: "x".repeat(MAX_PROPOSAL_BYTES) };
    expect(() => sealProposal(pair.publicKey, fat, NOW)).toThrow(/too large/);
  });
});

describe("proposalHash", () => {
  it("distinguishes two identical-looking proposals", () => {
    // the same ₹40 chai twice in a day is two entries, not a replay
    const pair = generateKeyPair();
    const a = openProposal(pair, sealProposal(pair.publicKey, draft, NOW), NOW);
    const b = openProposal(pair, sealProposal(pair.publicKey, draft, NOW), NOW);
    expect(proposalHash(a)).not.toBe(proposalHash(b));
  });

  it("is stable for one proposal regardless of key order", () => {
    const pair = generateKeyPair();
    const token = sealProposal(pair.publicKey, draft, NOW);
    const once = openProposal(pair, token, NOW);
    const twice = openProposal(pair, token, NOW);
    expect(proposalHash(once)).toBe(proposalHash(twice));
    expect(shortHandle(once)).toMatch(/^p_[0-9a-f]{6}$/);
  });
});

describe("assertFresh", () => {
  it("passes when the touched accounts have not moved", () => {
    const pair = generateKeyPair();
    const p = openProposal(pair, sealProposal(pair.publicKey, draft, NOW), NOW);
    expect(() => assertFresh(p, draft.fingerprint)).not.toThrow();
  });

  it("refuses once a quoted balance changed", () => {
    const pair = generateKeyPair();
    const p = openProposal(pair, sealProposal(pair.publicKey, draft, NOW), NOW);
    expect(() => assertFresh(p, "bank:235000:0|food:0:0")).toThrow(/ledger changed/);
  });
});

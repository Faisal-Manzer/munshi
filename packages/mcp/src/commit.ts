/**
 * Turning an approval into writes.
 *
 * Four things stand between a proposal id and a row in Postgres, and each one
 * exists because of a specific way this could go wrong:
 *
 *   the seal      — the model cannot invent a write the user never previewed
 *   the ledger    — a token scoped to one book cannot commit into another
 *   the replay    — an id offered twice writes once
 *   the freshness — the numbers approved are still the numbers on the books
 *
 * Only then are the ops applied, exactly as they were sealed. Nothing is
 * rebuilt from arguments here: rebuilding is how a preview and a write drift
 * apart (docs/MCP.md §2).
 */
import { assertBatchValid, type LedgerStore, type OpResult } from "@munshi/core";
import { balanceFingerprint, deriveView, type LedgerSnapshot } from "@munshi/store";
import type { KeyPair } from "@munshi/crypto";
import { McpError } from "./errors";
import { assertFresh, openProposal, proposalHash, shortHandle, type Proposal } from "./proposal";

/**
 * The one thing a stateless design must still remember.
 *
 * Hashes only — never the ops, never a description, never an amount. It is
 * the replay guard and the MCP audit trail at once (docs/MCP.md §5).
 */
export interface CommitLog {
  find(userId: string, proposalHash: string): Promise<{ committedAt: string } | null>;
  record(entry: {
    userId: string;
    ledgerId: string;
    proposalHash: string;
    summary: string;
    resultIds: string[];
  }): Promise<void>;
}

export interface CommitContext {
  userId: string;
  /** The ledger the caller's token is scoped to. */
  ledgerId: string;
  store: LedgerStore;
  /** Freshly loaded, so the fingerprint check compares against now. */
  snapshot: LedgerSnapshot;
  log: CommitLog;
  nowSeconds: number;
  serverKeys: KeyPair;
}

export interface CommitReceipt {
  handle: string;
  summary: string;
  results: OpResult[];
}

export async function commitProposal(
  token: string,
  ctx: CommitContext
): Promise<CommitReceipt> {
  const proposal = openProposal(ctx.serverKeys, token, ctx.nowSeconds);

  if (proposal.userId !== ctx.userId || proposal.ledgerId !== ctx.ledgerId) {
    // not "wrong ledger" — saying which would confirm the proposal is real
    throw new McpError("FORBIDDEN", "This proposal does not belong to this session.");
  }

  const hash = proposalHash(proposal);
  const already = await ctx.log.find(ctx.userId, hash);
  if (already) {
    throw new McpError(
      "ALREADY_COMMITTED",
      `This proposal was already committed at ${already.committedAt}. Nothing was written again.`
    );
  }

  assertFresh(proposal, fingerprintOf(ctx.snapshot, proposal));

  // the last line of defence: an encrypted book gives Postgres nothing to
  // check, so the legs are summed here before anything is written
  assertBatchValid(
    proposal.ops,
    ctx.snapshot.accounts.map((a) => a.id)
  );

  const results = await ctx.store.applyAll(proposal.ops);

  // recorded after the write: a crash between the two repeats the operation
  // at worst, where recording first would silently swallow it
  await ctx.log.record({
    userId: ctx.userId,
    ledgerId: ctx.ledgerId,
    proposalHash: hash,
    summary: proposal.summary,
    resultIds: results.map((r) => r.id).filter((id): id is string => Boolean(id)),
  });

  return { handle: shortHandle(proposal), summary: proposal.summary, results };
}

export function fingerprintOf(snapshot: LedgerSnapshot, proposal: Proposal): string {
  return balanceFingerprint(deriveView(snapshot).balances, proposal.accountIds);
}

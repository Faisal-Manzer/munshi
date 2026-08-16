/**
 * A proposal is not a record — it is the write itself, sealed.
 *
 * `propose_*` returns ops that have not been applied; `commit_proposal` writes
 * them. Between those two calls the state has to live somewhere, and this
 * design deliberately refuses to give it a home on the server: no session
 * table, no Redis, nothing that survives the request. Instead the whole
 * proposal is sealed to the server's own public key and handed back as the
 * `proposal_id` string (docs/MCP.md §2).
 *
 * What that buys:
 *
 *  - it works across serverless instances, because there is no server state
 *    for a second instance to be missing;
 *  - the model cannot forge one, since only the server's private key opens it;
 *  - commit replays the exact ops that were previewed, rather than rebuilding
 *    them from arguments and hoping the second build matches the first.
 *
 * What it costs: the blob is as big as the ops it carries, so a long EMI
 * schedule has to be carried as parameters rather than as generated rows.
 */
import {
  openSealed,
  randomBytes,
  seal,
  sha256Hex,
  toBase64,
  utf8,
  type KeyPair,
} from "@munshi/crypto";
import type { LedgerOp } from "@munshi/core";
import { McpError } from "./errors";

/** Version prefix, so a format change is a clean rejection rather than a misparse. */
const PREFIX = "mp1.";

/** Roughly the point where a proposal id stops being a sane tool argument. */
export const MAX_PROPOSAL_BYTES = 6 * 1024;

export const DEFAULT_TTL_SECONDS = 15 * 60;

export interface Proposal {
  v: 1;
  userId: string;
  ledgerId: string;
  /** The exact writes, in order. Commit replays these; it never re-derives. */
  ops: LedgerOp[];
  /** Accounts whose balances the preview quoted. */
  accountIds: string[];
  /** `balanceFingerprint` over those accounts at preview time. */
  fingerprint: string;
  /** One line naming what was approved, for the commit receipt and the audit row. */
  summary: string;
  /** Epoch seconds. */
  exp: number;
  /**
   * Makes every proposal distinct.
   *
   * Without it, two genuinely separate but identical entries — the same ₹40
   * chai twice in a day — would hash alike, and the replay guard would refuse
   * the second as already committed.
   */
  nonce: string;
}

export type NewProposal = Omit<Proposal, "v" | "exp" | "nonce">;

/**
 * Stable stringification, so the same proposal always hashes the same.
 *
 * The seal is randomised (each one uses a fresh ephemeral key), so the sealed
 * blob is useless as an identity. The replay guard hashes this instead.
 */
function canonical(p: Proposal): string {
  return JSON.stringify(p, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

export function proposalHash(p: Proposal): string {
  return sha256Hex(utf8(canonical(p)));
}

/**
 * @param nowSeconds passed in rather than read from the clock: this stays pure
 *   and testable, and the request already knows what time it is.
 */
export function sealProposal(
  serverPublicKey: string,
  proposal: NewProposal,
  nowSeconds: number,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string {
  const full: Proposal = {
    ...proposal,
    v: 1,
    exp: nowSeconds + ttlSeconds,
    nonce: toBase64(randomBytes(12)),
  };
  const bytes = utf8(JSON.stringify(full));
  if (bytes.length > MAX_PROPOSAL_BYTES) {
    throw new McpError(
      "PROPOSAL_TOO_LARGE",
      `This operation is too large to carry in a proposal (${bytes.length} bytes). ` +
        `Split it, or describe it by its parameters instead of its generated rows.`
    );
  }
  return PREFIX + seal(serverPublicKey, bytes);
}

export function openProposal(pair: KeyPair, token: string, nowSeconds: number): Proposal {
  if (!token.startsWith(PREFIX)) {
    throw new McpError("BAD_PROPOSAL", "Not a proposal id from this server.");
  }
  let parsed: Proposal;
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(openSealed(pair, token.slice(PREFIX.length)))
    ) as Proposal;
  } catch {
    // a failed seal is indistinguishable from a corrupted one, and saying
    // which would be a decryption oracle
    throw new McpError("BAD_PROPOSAL", "This proposal id could not be opened.");
  }
  if (parsed.v !== 1) throw new McpError("BAD_PROPOSAL", "Unknown proposal version.");
  if (parsed.exp <= nowSeconds) {
    throw new McpError(
      "EXPIRED_PROPOSAL",
      "This proposal has expired. Ask for it again to see a fresh preview."
    );
  }
  return parsed;
}

/**
 * Guard against approving one state and writing into another.
 *
 * The book can move between preview and commit — another device, the web app,
 * a second MCP client. If any account the preview quoted has a different
 * balance now, the approved before→after numbers are no longer true, so the
 * commit is refused and the caller re-previews.
 */
export function assertFresh(proposal: Proposal, fingerprintNow: string): void {
  if (proposal.fingerprint !== fingerprintNow) {
    throw new McpError(
      "STALE_PROPOSAL",
      "The ledger changed after this preview was made. Re-propose to see the current numbers."
    );
  }
}

/** Short, human-quotable handle for a proposal — for logs and receipts, never a lookup key. */
export function shortHandle(p: Proposal): string {
  return `p_${proposalHash(p).slice(0, 6)}`;
}

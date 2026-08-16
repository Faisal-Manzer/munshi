/**
 * The errors an MCP client is expected to handle, as codes rather than prose.
 *
 * A model reads these and decides what to do next — re-authorize, re-propose,
 * pick a ledger — so the code is the contract and the message is only for the
 * human reading the transcript (docs/MCP.md §5).
 */
export type McpErrorCode =
  | "NO_LEDGER"
  | "LOCKED"
  | "STALE_PROPOSAL"
  | "EXPIRED_PROPOSAL"
  | "ALREADY_COMMITTED"
  | "UNBALANCED"
  | "LIKELY_DUPLICATE"
  | "PROPOSAL_TOO_LARGE"
  | "BAD_PROPOSAL"
  | "FORBIDDEN"
  | "NOT_FOUND";

export class McpError extends Error {
  readonly code: McpErrorCode;
  /** Anything the client needs to recover: a ledger list, a fresh preview, the duplicate found. */
  readonly data?: unknown;

  constructor(code: McpErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

export function isMcpError(e: unknown): e is McpError {
  return e instanceof McpError;
}

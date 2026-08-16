/**
 * @munshi/store — where an op becomes rows.
 *
 * The codec decides what the server may read; the Supabase driver decides how
 * a `LedgerOp` reaches Postgres. Both are needed anywhere a book is written,
 * which as of the MCP server is no longer only the browser — a request
 * holding a ledger key seals rows with exactly this code (docs/MCP.md §6).
 *
 * Nothing here is React-aware or browser-only: `crypto.randomUUID` and
 * WebCrypto exist on Node 24 too.
 */
export * from "./codec";
export * from "./supabase";

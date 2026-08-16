/**
 * @munshi/mcp — Munshi as a tool surface.
 *
 * Everything the UI can do, exposed to an MCP client, with a preview the user
 * approves before anything is written (docs/MCP.md). Pure: the transport, the
 * OAuth routes and the Supabase client are wired up in the app.
 */
export * from "./errors";
export * from "./preview";
export * from "./proposal";
export * from "./simulate";
export * from "./operations/types";
export * from "./operations/accounts";
export * from "./operations/reconcile";

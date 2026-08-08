/**
 * @munshi/core — the headless brain.
 *
 * Types, money formatting, ledger conventions, the calculation layer, and the
 * one mutation API. Zero dependencies, no DOM, no network: the same code runs
 * in the web app, mobile apps, the MCP server, and inside the E2EE boundary
 * (docs/E2EE.md §9 step 0).
 */
export * from "./types";
export * from "./money";
export * from "./emi";
export * from "./ledger";
export * from "./calc";
export * from "./search";
export * from "./store";
export * from "./entries";

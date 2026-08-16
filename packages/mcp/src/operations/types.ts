/**
 * An operation turns a request into two things: the ops to write, and the
 * preview that has to be approved before they are.
 *
 * Both come from one function so they cannot disagree. A tool that built a
 * preview separately from the ops would eventually preview one thing and
 * write another, which is the exact failure this whole design exists to
 * prevent (docs/MCP.md §2).
 */
import type { LedgerOp } from "@munshi/core";
import type { Preview } from "../preview";

export interface Operation {
  ops: LedgerOp[];
  preview: Preview;
  /** One line for the receipt and the audit row. */
  summary: string;
}

/** Ids are minted by the caller so a batch can reference what it creates. */
export type MintId = () => string;

export const uuid: MintId = () => crypto.randomUUID();

/**
 * The tool surface: everything the UI can do, as tools.
 *
 * Two rules hold across all of them.
 *
 * Reads never prompt. Writes never write — a `propose_*` tool returns a
 * preview and a proposal id, and only `commit_proposal` touches the database.
 * That is not a convention the model is asked to follow; it is the only shape
 * the code offers, because the propose tools have no store to write with.
 *
 * The session is resolved per call, not per connection. A serverless instance
 * holds the ledger key for the length of one request and wipes it after
 * (docs/MCP.md §1), so there is nothing to keep between tools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  accountById,
  computeCardCycles,
  displayBalance,
  emiInfo,
  formatPaise,
  isCard,
  subtreeBalance,
  type Account,
} from "@munshi/core";
import { balanceFingerprint, deriveView, type LedgerSnapshot } from "@munshi/store";
import type { KeyPair } from "@munshi/crypto";
import { commitProposal, type CommitLog } from "./commit";
import { McpError, isMcpError } from "./errors";
import { renderPreview } from "./preview";
import { sealProposal } from "./proposal";
import { touchedAccountIds } from "./simulate";
import type { Operation } from "./operations/types";
import { ACCOUNT_TYPES, proposeAccount, type AccountType } from "./operations/accounts";
import { proposeCardEmi } from "./operations/cards";
import {
  proposeEntry,
  proposeEntryDelete,
  proposeEntryEdit,
  proposeMarkDone,
  proposeTransfer,
} from "./operations/entries";
import { proposeLoan } from "./operations/loans";
import { proposeReconcile } from "./operations/reconcile";

export interface LedgerRef {
  id: string;
  name: string;
}

/**
 * What a request needs to do anything.
 *
 * The host supplies this per call: it is the thing that holds the ledger key,
 * and it is deliberately not stored anywhere this package can reach.
 */
export interface McpContext {
  userId: string;
  ledgerId: string | null;
  /** The books this user can open, for the "pick one" error and `list_ledgers`. */
  listLedgers(): Promise<LedgerRef[]>;
  /** Loads and decrypts the active book. Throws LOCKED if there is no key. */
  snapshot(): Promise<LedgerSnapshot>;
  /** Applies a committed batch. */
  commitContext(): Promise<Omit<Parameters<typeof commitProposal>[1], "serverKeys">>;
  log: CommitLog;
  serverKeys: KeyPair;
  nowSeconds: number;
  today: string;
  nowISO: string;
}

export type ContextFactory = () => Promise<McpContext>;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (body: string): ToolResult => ({ content: [{ type: "text", text: body }] });

/**
 * Errors reach the model as text, not as protocol failures.
 *
 * A refused write is information — "this looks like a duplicate", "pick a
 * ledger" — and a model that sees a transport error tends to retry rather
 * than read. The code is put first so it can be matched without parsing prose.
 */
function failure(e: unknown): ToolResult {
  if (isMcpError(e)) {
    const detail = e.data ? `\n\n${JSON.stringify(e.data, null, 2)}` : "";
    return { content: [{ type: "text", text: `${e.code}: ${e.message}${detail}` }], isError: true };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

async function withLedger<T>(
  ctx: McpContext,
  fn: (snapshot: LedgerSnapshot, ledgerId: string) => Promise<T> | T
): Promise<T> {
  if (!ctx.ledgerId) {
    const ledgers = await ctx.listLedgers();
    throw new McpError(
      "NO_LEDGER",
      "No ledger selected for this session. Ask the user which book to work in, then call select_ledger.",
      { ledgers }
    );
  }
  return fn(await ctx.snapshot(), ctx.ledgerId);
}

/** Turns an operation into the two things a client needs: the preview, and the id to approve it with. */
function proposalResponse(
  ctx: McpContext,
  snapshot: LedgerSnapshot,
  ledgerId: string,
  operation: Operation
): ToolResult {
  const accountIds = touchedAccountIds(operation.ops);
  const token = sealProposal(
    ctx.serverKeys.publicKey,
    {
      userId: ctx.userId,
      ledgerId,
      ops: operation.ops,
      accountIds,
      fingerprint: balanceFingerprint(deriveView(snapshot).balances, accountIds),
      summary: operation.summary,
    },
    ctx.nowSeconds
  );
  return text(
    `${renderPreview(operation.preview)}\n\n` +
      `Nothing has been written yet. Show this to the user, and call commit_proposal ` +
      `with this id once they approve it:\n\n${token}`
  );
}

const money = z
  .number()
  .int()
  .describe("Amount in paise — ₹450.50 is 45050. Never send rupees.");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("yyyy-mm-dd");

/**
 * The SDK's `registerTool` is generic over the schema, so its inferred
 * argument types are unusable in a shared wrapper. Declaring the config
 * structurally keeps the registration typed at the call sites — where the
 * schema is actually written — instead of everywhere it is threaded through.
 */
interface ToolConfig {
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
}

export function registerTools(server: McpServer, contextFor: ContextFactory): void {
  const tool = (
    name: string,
    config: ToolConfig,
    run: (args: never, ctx: McpContext) => Promise<ToolResult>
  ) => {
    server.registerTool(name, config as never, (async (args: never) => {
      try {
        return await run(args, await contextFor());
      } catch (e) {
        return failure(e);
      }
    }) as never);
  };

  // ---- session ------------------------------------------------------------

  tool(
    "list_ledgers",
    {
      title: "List ledgers",
      description: "The books this account can open, and which one this session is using.",
      inputSchema: {},
    },
    async (_args, ctx) => {
      const ledgers = await ctx.listLedgers();
      return text(
        ledgers
          .map((l) => `${l.id === ctx.ledgerId ? "* " : "  "}${l.name}  ${l.id}`)
          .join("\n") || "No ledgers on this account."
      );
    }
  );

  tool(
    "select_ledger",
    {
      title: "Select ledger",
      description:
        "Switch the book this session works in. Each book has its own key, so switching " +
        "sends the user through the browser to unlock the new one.",
      inputSchema: { ledger_id: z.string() },
    },
    async ({ ledger_id }: { ledger_id: string }, ctx) => {
      const ledgers = await ctx.listLedgers();
      const target = ledgers.find((l) => l.id === ledger_id);
      if (!target) throw new McpError("NOT_FOUND", `No ledger ${ledger_id} on this account.`);
      if (target.id === ctx.ledgerId) return text(`Already working in ${target.name}.`);
      // the server cannot unwrap another book's key from the token it holds —
      // that is the design working, not an obstacle to route around
      throw new McpError(
        "LOCKED",
        `${target.name} is encrypted with its own key. Ask the user to reconnect Munshi and ` +
          `pick "${target.name}" when the browser asks which book to open.`
      );
    }
  );

  // ---- reads --------------------------------------------------------------

  tool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "Every account with its balance. Liabilities read as what is owed; a parent bank or " +
        "card includes its envelopes and sub-cards.",
      inputSchema: { include_archived: z.boolean().optional() },
    },
    async ({ include_archived }: { include_archived?: boolean }, ctx) =>
      withLedger(ctx, (snapshot) => {
        const view = deriveView(snapshot, new Date(ctx.today + "T00:00:00"));
        const rows = snapshot.accounts
          .filter((a) => include_archived || !a.archived)
          .map((a: Account) => {
            const raw = a.parent_id
              ? (view.balances.get(a.id)?.balance_paise ?? 0)
              : subtreeBalance(snapshot.accounts, view.balances, a.id);
            const parent = a.parent_id ? accountById(snapshot.accounts, a.parent_id) : null;
            return [
              a.id,
              a.name + (parent ? ` (under ${parent.name})` : ""),
              `${a.kind}/${a.subtype}`,
              formatPaise(displayBalance(a, raw)),
              a.is_liquid ? "liquid" : "",
            ].join("  ");
          });
        return text(rows.join("\n") || "No accounts yet.");
      })
  );

  tool(
    "list_entries",
    {
      title: "List entries",
      description: "Entries in the book, newest first, filtered however you need.",
      inputSchema: {
        from_date: isoDate.optional(),
        to_date: isoDate.optional(),
        account_id: z.string().optional(),
        status: z.enum(["pending", "done"]).optional(),
        search: z.string().optional().describe("Matches the description, case-insensitively"),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async (
      args: {
        from_date?: string;
        to_date?: string;
        account_id?: string;
        status?: "pending" | "done";
        search?: string;
        limit: number;
      },
      ctx
    ) =>
      withLedger(ctx, (snapshot) => {
        const legsOf = new Map<string, typeof snapshot.postings>();
        for (const p of snapshot.postings) {
          legsOf.set(p.transaction_id, [...(legsOf.get(p.transaction_id) ?? []), p]);
        }
        const rows = snapshot.transactions
          .filter((t) => !args.from_date || t.date >= args.from_date)
          .filter((t) => !args.to_date || t.date <= args.to_date)
          .filter((t) => !args.status || t.status === args.status)
          .filter(
            (t) =>
              !args.search ||
              t.description.toLowerCase().includes(args.search.toLowerCase())
          )
          .filter(
            (t) =>
              !args.account_id ||
              (legsOf.get(t.id) ?? []).some((p) => p.account_id === args.account_id)
          )
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
          .slice(0, args.limit)
          .map((t) => {
            const legs = legsOf.get(t.id) ?? [];
            const size = Math.max(...legs.map((l) => Math.abs(l.amount_paise)), 0);
            const accounts = legs
              .map((l) => accountById(snapshot.accounts, l.account_id)?.name ?? "?")
              .join(" → ");
            return `${t.date}  ${t.description}  ${formatPaise(size)}  ${accounts}${
              t.status === "pending" ? "  (pending)" : ""
            }  ${t.id}`;
          });
        return text(rows.join("\n") || "No entries match.");
      })
  );

  tool(
    "card_cycles",
    {
      title: "Card cycles",
      description: "Per credit card: statement cutoff, what is billed, and what is not yet billed.",
      inputSchema: {},
    },
    async (_args, ctx) =>
      withLedger(ctx, (snapshot) => {
        const cycles = computeCardCycles(snapshot, new Date(ctx.today + "T00:00:00"));
        const rows = snapshot.accounts
          .filter((a) => isCard(a) && !a.archived)
          .map((card) => {
            const c = cycles.get(card.id);
            return [
              card.name,
              `cutoff ${c?.cutoff ?? "—"}`,
              `billed ${formatPaise(displayBalance(card, c?.billed_paise ?? 0))}`,
              `since ${formatPaise(displayBalance(card, c?.spends_since_paise ?? 0))}`,
              card.due_day ? `due day ${card.due_day}` : "",
            ].join("  ");
          });
        return text(rows.join("\n") || "No credit cards in this book.");
      })
  );

  tool(
    "list_templates",
    {
      title: "List recurring and EMIs",
      description: "Recurring templates, with EMI progress where a template has installments.",
      inputSchema: { month: z.string().regex(/^\d{4}-\d{2}$/).optional() },
    },
    async ({ month }: { month?: string }, ctx) =>
      withLedger(ctx, (snapshot) => {
        const m = month ?? ctx.today.slice(0, 7);
        const rows = snapshot.templates.map((t) => {
          const emi = emiInfo(t, m);
          return [
            t.name,
            formatPaise(t.amount_paise),
            `day ${t.day_of_month}`,
            emi ? `installment ${emi.idx}/${emi.total} (ends ${emi.endISO})` : t.kind,
            t.active ? "" : "inactive",
            t.id,
          ]
            .filter(Boolean)
            .join("  ");
        });
        return text(rows.join("\n") || "No recurring templates.");
      })
  );

  // ---- writes: entries ----------------------------------------------------

  const entryShape = {
    date: isoDate,
    description: z.string().min(1),
    from_account_id: z.string().describe("Where the money leaves — bank, cash or card"),
    to_account_id: z.string().describe("Where it lands — expense category, person, or account"),
    amount_paise: money,
    status: z.enum(["pending", "done"]).default("done"),
    tag: z.string().optional(),
    notes: z.string().optional(),
  };

  tool(
    "propose_entry",
    {
      title: "Propose an entry",
      description:
        "Preview a spend, income or payment. Nothing is written until commit_proposal. " +
        "Use reimburse_* when someone owes part of it back — a split bill.",
      inputSchema: {
        ...entryShape,
        reimburse_account_id: z.string().optional(),
        reimburse_paise: money.optional(),
        allow_duplicate: z.boolean().optional(),
      },
    },
    async (args: Record<string, never>, ctx) =>
      withLedger(ctx, (snapshot, ledgerId) => {
        const a = args as unknown as {
          date: string;
          description: string;
          from_account_id: string;
          to_account_id: string;
          amount_paise: number;
          status: "pending" | "done";
          tag?: string;
          notes?: string;
          reimburse_account_id?: string;
          reimburse_paise?: number;
          allow_duplicate?: boolean;
        };
        return proposalResponse(
          ctx,
          snapshot,
          ledgerId,
          proposeEntry(snapshot, {
            ledgerId,
            date: a.date,
            description: a.description,
            status: a.status,
            fromAccountId: a.from_account_id,
            toAccountId: a.to_account_id,
            amountPaise: a.amount_paise,
            reimburseAccountId: a.reimburse_account_id ?? null,
            reimbursePaise: a.reimburse_paise ?? null,
            tag: a.tag ?? null,
            notes: a.notes ?? null,
            allowDuplicate: a.allow_duplicate,
          })
        );
      })
  );

  tool(
    "propose_transfer",
    {
      title: "Propose a transfer",
      description: "Move money between two accounts you own — bank to envelope, bank to card payment.",
      inputSchema: entryShape,
    },
    async (args: Record<string, never>, ctx) =>
      withLedger(ctx, (snapshot, ledgerId) => {
        const a = args as unknown as {
          date: string;
          description: string;
          from_account_id: string;
          to_account_id: string;
          amount_paise: number;
          status: "pending" | "done";
          tag?: string;
          notes?: string;
        };
        return proposalResponse(
          ctx,
          snapshot,
          ledgerId,
          proposeTransfer(snapshot, {
            ledgerId,
            date: a.date,
            description: a.description,
            status: a.status,
            fromAccountId: a.from_account_id,
            toAccountId: a.to_account_id,
            amountPaise: a.amount_paise,
            tag: a.tag ?? null,
            notes: a.notes ?? null,
          })
        );
      })
  );

  tool(
    "propose_entry_edit",
    {
      title: "Propose an edit",
      description: "Rewrite an existing entry. Its legs are replaced wholesale.",
      inputSchema: { transaction_id: z.string(), ...entryShape },
    },
    async (args: Record<string, never>, ctx) =>
      withLedger(ctx, (snapshot, ledgerId) => {
        const a = args as unknown as {
          transaction_id: string;
          date: string;
          description: string;
          from_account_id: string;
          to_account_id: string;
          amount_paise: number;
          status: "pending" | "done";
          tag?: string;
          notes?: string;
        };
        return proposalResponse(
          ctx,
          snapshot,
          ledgerId,
          proposeEntryEdit(snapshot, a.transaction_id, {
            date: a.date,
            description: a.description,
            status: a.status,
            fromAccountId: a.from_account_id,
            toAccountId: a.to_account_id,
            amountPaise: a.amount_paise,
            tag: a.tag ?? null,
            notes: a.notes ?? null,
          })
        );
      })
  );

  tool(
    "propose_entry_delete",
    {
      title: "Propose a deletion",
      description: "Remove an entry and both its legs. Permanent — prefer an adjustment where history matters.",
      inputSchema: { transaction_id: z.string() },
    },
    async ({ transaction_id }: { transaction_id: string }, ctx) =>
      withLedger(ctx, (snapshot, ledgerId) =>
        proposalResponse(ctx, snapshot, ledgerId, proposeEntryDelete(snapshot, transaction_id))
      )
  );

  tool(
    "propose_mark_done",
    {
      title: "Propose settling an entry",
      description: "Move a pending entry to settled, optionally on a different date.",
      inputSchema: { transaction_id: z.string(), date: isoDate.optional() },
    },
    async ({ transaction_id, date }: { transaction_id: string; date?: string }, ctx) =>
      withLedger(ctx, (snapshot, ledgerId) =>
        proposalResponse(ctx, snapshot, ledgerId, proposeMarkDone(snapshot, transaction_id, date))
      )
  );

  // ---- writes: accounts and operations ------------------------------------

  tool(
    "propose_account",
    {
      title: "Propose a new account",
      description:
        `Create an account. Types: ${Object.entries(ACCOUNT_TYPES)
          .map(([k, v]) => `${k} (${v.label})`)
          .join(", ")}. An envelope needs a parent bank; a card sub-account needs a parent card.`,
      inputSchema: {
        type: z.enum(Object.keys(ACCOUNT_TYPES) as [AccountType, ...AccountType[]]),
        name: z.string().min(1),
        parent_id: z.string().optional(),
        statement_day: z.number().int().min(1).max(31).optional(),
        due_day: z.number().int().min(1).max(31).optional(),
        credit_limit_paise: money.optional(),
        opening_balance_paise: money.optional().describe("What it already holds, booked to equity"),
        is_liquid: z.boolean().optional(),
      },
    },
    async (args: Record<string, never>, ctx) =>
      withLedger(ctx, (snapshot, ledgerId) => {
        const a = args as unknown as {
          type: AccountType;
          name: string;
          parent_id?: string;
          statement_day?: number;
          due_day?: number;
          credit_limit_paise?: number;
          opening_balance_paise?: number;
          is_liquid?: boolean;
        };
        return proposalResponse(
          ctx,
          snapshot,
          ledgerId,
          proposeAccount(snapshot, {
            ledgerId,
            type: a.type,
            name: a.name,
            parentId: a.parent_id ?? null,
            statementDay: a.statement_day ?? null,
            dueDay: a.due_day ?? null,
            creditLimitPaise: a.credit_limit_paise ?? null,
            openingBalancePaise: a.opening_balance_paise ?? null,
            isLiquid: a.is_liquid,
            today: ctx.today,
          })
        );
      })
  );

  tool(
    "propose_loan",
    {
      title: "Propose a loan",
      description:
        "Set up a loan in one approval: the account, the disbursal, and the repayment schedule. " +
        "direction=borrowed for money you took, lent for money you gave.",
      inputSchema: {
        direction: z.enum(["borrowed", "lent"]),
        name: z.string().min(1).describe("The lender, or the person you lent to"),
        principal_paise: money,
        rate_percent: z.number().min(0).describe("Annual, reducing balance. 0 is allowed."),
        months: z.number().int().min(1),
        counter_account_id: z.string().describe("The bank or cash account the money moves through"),
        first_due: isoDate,
        disbursed_on: isoDate.optional(),
      },
    },
    async (args: Record<string, never>, ctx) =>
      withLedger(ctx, (snapshot, ledgerId) => {
        const a = args as unknown as {
          direction: "borrowed" | "lent";
          name: string;
          principal_paise: number;
          rate_percent: number;
          months: number;
          counter_account_id: string;
          first_due: string;
          disbursed_on?: string;
        };
        return proposalResponse(
          ctx,
          snapshot,
          ledgerId,
          proposeLoan(snapshot, {
            ledgerId,
            direction: a.direction,
            name: a.name,
            principalPaise: a.principal_paise,
            ratePercent: a.rate_percent,
            months: a.months,
            counterAccountId: a.counter_account_id,
            firstDueISO: a.first_due,
            disbursedISO: a.disbursed_on,
            today: ctx.today,
          })
        );
      })
  );

  tool(
    "propose_card_emi",
    {
      title: "Propose a card EMI",
      description:
        "Convert a card purchase into installments. Give the full purchase amount, not the " +
        "monthly slice. If the purchase is already logged as one spend, this refuses until you " +
        "say whether to reverse it.",
      inputSchema: {
        card_id: z.string(),
        description: z.string().min(1),
        total_paise: money,
        months: z.number().int().min(1),
        expense_account_id: z.string(),
        first_billing: isoDate,
        processing_fee_paise: money.optional(),
        duplicate: z.enum(["ignore", "reverse"]).optional(),
      },
    },
    async (args: Record<string, never>, ctx) =>
      withLedger(ctx, (snapshot, ledgerId) => {
        const a = args as unknown as {
          card_id: string;
          description: string;
          total_paise: number;
          months: number;
          expense_account_id: string;
          first_billing: string;
          processing_fee_paise?: number;
          duplicate?: "ignore" | "reverse";
        };
        return proposalResponse(
          ctx,
          snapshot,
          ledgerId,
          proposeCardEmi(snapshot, {
            ledgerId,
            cardId: a.card_id,
            description: a.description,
            totalPaise: a.total_paise,
            months: a.months,
            expenseAccountId: a.expense_account_id,
            firstBillingISO: a.first_billing,
            processingFeePaise: a.processing_fee_paise ?? null,
            duplicate: a.duplicate,
            today: ctx.today,
          })
        );
      })
  );

  tool(
    "propose_reconcile",
    {
      title: "Propose a reconciliation",
      description:
        "Match an account to what the real world says. Enter the real balance positive — for a " +
        "card or loan that means what is owed. A person needs owes_me, because the debt can run " +
        "either way.",
      inputSchema: {
        account_id: z.string(),
        real_balance_paise: money,
        owes_me: z.boolean().optional(),
        apply_adjustment: z.boolean().default(true),
      },
    },
    async (args: Record<string, never>, ctx) =>
      withLedger(ctx, (snapshot, ledgerId) => {
        const a = args as unknown as {
          account_id: string;
          real_balance_paise: number;
          owes_me?: boolean;
          apply_adjustment: boolean;
        };
        return proposalResponse(
          ctx,
          snapshot,
          ledgerId,
          proposeReconcile(snapshot, {
            ledgerId,
            accountId: a.account_id,
            realBalancePaise: a.real_balance_paise,
            owesMe: a.owes_me,
            applyAdjustment: a.apply_adjustment,
            today: ctx.today,
            nowISO: ctx.nowISO,
          })
        );
      })
  );

  // ---- the only tool that writes ------------------------------------------

  tool(
    "commit_proposal",
    {
      title: "Commit an approved proposal",
      description:
        "Write a proposal to the ledger. Call this only after the user has seen the preview and " +
        "said yes. Refuses if the book changed since the preview, or if this proposal was " +
        "already committed.",
      inputSchema: { proposal_id: z.string() },
    },
    async ({ proposal_id }: { proposal_id: string }, ctx) => {
      const base = await ctx.commitContext();
      const receipt = await commitProposal(proposal_id, { ...base, serverKeys: ctx.serverKeys });
      return text(
        `Written. ${receipt.summary}\n${receipt.results.length} row(s) ` +
          `(${receipt.results.map((r) => r.kind).join(", ")}), reference ${receipt.handle}.`
      );
    }
  );
}

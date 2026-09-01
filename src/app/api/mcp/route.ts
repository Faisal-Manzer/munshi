/**
 * The MCP endpoint.
 *
 * One request, one key: the access token carries the ledger key sealed to this
 * deployment's public key, so the handler opens it, does the work, and wipes
 * it. Nothing about the session survives the response — no cache, no store, no
 * module-level state — which is what makes this safe to run on an instance
 * that may serve a different user's next request (docs/MCP.md §0).
 */
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { openSealed, wipe } from "@munshi/crypto";
import { createSupabaseStore, loadLedger } from "@munshi/store";
import {
  registerTools,
  type CallerAuth,
  type CommitLog,
  type McpContext,
} from "@munshi/mcp";
import { adminClient, assertCanWrite, assertMember, ledgersFor } from "@/lib/mcp/admin";
import { sealKeys } from "@/lib/mcp/server-keys";
import { readToken } from "@/lib/mcp/tokens";

export const maxDuration = 120;

interface Session {
  userId: string;
  email: string | null;
  ledgerId: string;
  sealedKey: string;
}

/** The token's claims, as the transport hands them over. */
function sessionFrom(auth: CallerAuth | undefined): Session {
  const extra = auth?.extra as
    | { userId?: string; email?: string | null; ledgerId?: string; sealedKey?: string }
    | undefined;
  // Name what is actually absent. "Reconnect to unlock" is the right advice
  // only when the token genuinely carries no key; when the auth info never
  // arrived at all, reconnecting forever cannot fix it, and a caller who is
  // told to reconnect will do exactly that instead of reporting the bug.
  if (!auth) {
    throw new Error(
      "No auth info reached this tool call — the bearer token was accepted but " +
        "its claims were not forwarded. This is a server bug, not something " +
        "reconnecting will fix."
    );
  }
  if (!extra) {
    throw new Error("Auth info arrived with no claims attached. This is a server bug.");
  }
  const missing = (["userId", "ledgerId", "sealedKey"] as const).filter((k) => !extra[k]);
  if (!extra.userId || !extra.ledgerId || !extra.sealedKey) {
    throw new Error(
      `This session's token is missing ${missing.join(", ")}. ` +
        "Disconnect Munshi and reconnect, choosing a book and entering your " +
        "encryption passphrase at the consent screen."
    );
  }
  return {
    userId: extra.userId,
    email: extra.email ?? null,
    ledgerId: extra.ledgerId,
    sealedKey: extra.sealedKey,
  };
}

/** The commit log: hashes in, hashes out. It never sees an amount. */
function commitLog(supabase: ReturnType<typeof adminClient>): CommitLog {
  return {
    async find(userId, proposalHash) {
      const { data } = await supabase
        .from("mcp_commit_log")
        .select("committed_at")
        .eq("user_id", userId)
        .eq("proposal_hash", proposalHash)
        .maybeSingle();
      return data ? { committedAt: data.committed_at } : null;
    },
    async record(entry) {
      const { error } = await supabase.from("mcp_commit_log").insert({
        user_id: entry.userId,
        ledger_id: entry.ledgerId,
        proposal_hash: entry.proposalHash,
        summary: entry.summary,
        result_ids: entry.resultIds,
      });
      if (error) throw new Error(error.message);
    },
  };
}

/**
 * Builds everything a tool call needs, per call.
 *
 * The ledger key is unsealed here and passed only to the loader and the store.
 * Both hold it for the length of the call; the `finally` in each tool's
 * lifetime is this function's caller returning, after which nothing references
 * it.
 */
async function buildContext(auth: CallerAuth | undefined): Promise<McpContext> {
  const session = sessionFrom(auth);
  {
    const supabase = adminClient();
    const access = await assertMember(supabase, session.email, session.ledgerId);
    const keys = sealKeys();
    const now = new Date();

    const ledgerKey = openSealed(keys, session.sealedKey);

    const snapshot = async () => loadLedger(supabase, session.ledgerId, ledgerKey);

    return {
      dispose: () => wipe(ledgerKey),
      userId: session.userId,
      ledgerId: session.ledgerId,
      listLedgers: async () =>
        (await ledgersFor(supabase, session.email)).map((l) => ({
          id: l.ledgerId,
          name: l.name,
        })),
      snapshot,
      commitContext: async () => {
        // a viewer may look and may preview; committing is where the role bites
        assertCanWrite(access);
        return {
          userId: session.userId,
          ledgerId: session.ledgerId,
          store: createSupabaseStore(supabase, ledgerKey),
          snapshot: await snapshot(),
          log: commitLog(supabase),
          nowSeconds: Math.floor(now.getTime() / 1000),
        };
      },
      log: commitLog(supabase),
      serverKeys: keys,
      nowSeconds: Math.floor(now.getTime() / 1000),
      today: now.toISOString().slice(0, 10),
      nowISO: now.toISOString(),
    };
  }
}

/**
 * mcp-handler builds the server per request, so the session has to be reachable
 * from the factory. It is passed through `authInfo` rather than a module
 * variable — two concurrent requests on one warm instance must never see each
 * other's key.
 */
const handler = withMcpAuth(
  createMcpHandler(
    (server) => {
      registerTools(server, buildContext);
    },
    { serverInfo: { name: "munshi", version: "0.1.0" }, capabilities: { tools: {} } }
  ),
  async (_req, bearer) => {
    if (!bearer) return undefined;
    const claims = await readToken(bearer, "access");
    if (!claims) return undefined;
    // the email is what membership is keyed on (migration 008), and it is not
    // in our token — so it is looked up once here rather than per tool call
    const supabase = adminClient();
    const { data } = await supabase.auth.admin.getUserById(claims.sub);

    return {
      token: bearer,
      clientId: claims.sub,
      scopes: claims.scope.split(" "),
      expiresAt: claims.exp,
      extra: {
        userId: claims.sub,
        email: data.user?.email ?? null,
        ledgerId: claims.ledger_id,
        sealedKey: claims.skey,
      },
    } satisfies AuthInfo;
  },
  {
    required: true,
    requiredScopes: ["ledger:read"],
    resourceMetadataPath: "/.well-known/oauth-protected-resource",
  }
);

export { handler as GET, handler as POST, handler as DELETE };

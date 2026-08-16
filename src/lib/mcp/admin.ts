import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The service-role client, and why MCP needs one.
 *
 * Every other path in this app talks to Postgres as the signed-in user, and
 * RLS does the enforcing. An MCP request has no Supabase session to borrow:
 * it arrives with our own access token, and Supabase's refresh tokens rotate
 * on use, which a stateless server cannot keep up with.
 *
 * So MCP reads and writes with the service role and enforces access itself —
 * `assertMember` below is the check RLS would otherwise be making, and every
 * query must be scoped by the ledger it returns. That is a real transfer of
 * responsibility from the database to this code, and it is written down here
 * so it is not discovered later by accident.
 */
export function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service role credentials are not configured.");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface LedgerAccess {
  ledgerId: string;
  name: string;
  role: "owner" | "editor" | "viewer";
}

/**
 * The books a user may open.
 *
 * Membership is by email, not by user id (migration 008) — that is what lets
 * someone be invited to a ledger before they have ever signed in. So the email
 * on the session is the identity that matters here, and a request without one
 * can open nothing.
 */
export async function ledgersFor(
  supabase: SupabaseClient,
  email: string | null
): Promise<LedgerAccess[]> {
  if (!email) return [];
  const { data, error } = await supabase
    .from("ledger_memberships")
    .select("ledger_id, role, ledgers(id, name, archived)")
    .eq("email", email.toLowerCase());
  if (error) throw new Error(error.message);

  const out: LedgerAccess[] = [];
  for (const row of data ?? []) {
    const ledger = row.ledgers as unknown as { id: string; name: string; archived: boolean } | null;
    if (!ledger || ledger.archived) continue;
    out.push({
      ledgerId: ledger.id,
      name: ledger.name,
      role: (row.role as LedgerAccess["role"]) ?? "viewer",
    });
  }
  return out;
}

/** The check RLS is no longer making. Throws rather than returning false. */
export async function assertMember(
  supabase: SupabaseClient,
  email: string | null,
  ledgerId: string
): Promise<LedgerAccess> {
  const access = (await ledgersFor(supabase, email)).find((l) => l.ledgerId === ledgerId);
  if (!access) throw new Error("This session's ledger is not one this account can open.");
  return access;
}

/** Writes need editor or owner; a viewer may read and preview but never commit. */
export function assertCanWrite(access: LedgerAccess): void {
  if (access.role === "viewer") {
    throw new Error(`You have view-only access to ${access.name}.`);
  }
}

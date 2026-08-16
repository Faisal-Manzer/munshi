/**
 * Mints the authorization code, once the browser has done the part the server
 * cannot: unlock the book.
 *
 * This runs as the signed-in user, from the consent page, so the identity is
 * taken from the Supabase session rather than from anything the request body
 * claims. The body's job is only to carry the sealed key and the client's PKCE
 * challenge (docs/MCP.md §1).
 */
import { createClient } from "@/lib/supabase/server";
import { adminClient, ledgersFor } from "@/lib/mcp/admin";
import { hashSecret, randomToken } from "@/lib/mcp/tokens";

const CODE_TTL_SECONDS = 120;

function fail(description: string, status = 400) {
  return Response.json({ error: "invalid_request", error_description: description }, { status });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Not signed in.", 401);

  const body = (await request.json().catch(() => null)) as {
    client_id?: string;
    redirect_uri?: string;
    code_challenge?: string;
    scope?: string;
    ledger_id?: string;
    sealed_key?: string;
  } | null;
  if (!body) return fail("Body must be JSON.");

  const { client_id, redirect_uri, code_challenge, ledger_id, sealed_key } = body;
  if (!client_id || !redirect_uri || !code_challenge || !ledger_id || !sealed_key) {
    return fail("Missing parameters.");
  }

  const admin = adminClient();

  const { data: client } = await admin
    .from("oauth_clients")
    .select("client_id, redirect_uris")
    .eq("client_id", client_id)
    .maybeSingle();
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    return fail("Unknown client, or a redirect it did not register.");
  }

  // the page offered only ledgers this account can open; check it again here,
  // because the page is not what enforces it
  const access = (await ledgersFor(admin, user.email ?? null)).find(
    (l) => l.ledgerId === ledger_id
  );
  if (!access) return fail("That book is not one this account can open.", 403);

  const code = randomToken(32);
  const { error } = await admin.from("oauth_codes").insert({
    code_hash: hashSecret(code),
    client_id,
    user_id: user.id,
    ledger_id,
    redirect_uri,
    code_challenge,
    sealed_key,
    scope: access.role === "viewer" ? "ledger:read" : (body.scope ?? "ledger:read ledger:write"),
    expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) {
    return Response.json(
      { error: "server_error", error_description: error.message },
      { status: 500 }
    );
  }

  return Response.json({ code });
}

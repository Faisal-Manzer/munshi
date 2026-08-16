/**
 * Dynamic client registration (RFC 7591).
 *
 * Anyone may register: that is what the spec intends, and it is safe here
 * because registering grants nothing. A client_id is only a name — every
 * token still requires a human to sign in, pick a book, and type a passphrase
 * in a browser this client does not control.
 *
 * Public clients only. No secret is issued, because an MCP client runs on the
 * user's machine and cannot keep one; PKCE is the proof instead.
 */
import { adminClient } from "@/lib/mcp/admin";
import { randomToken } from "@/lib/mcp/tokens";

const MAX_REDIRECT_URIS = 10;

function badRequest(error: string, description: string) {
  return Response.json({ error, error_description: description }, { status: 400 });
}

export async function POST(request: Request) {
  let body: { client_name?: string; redirect_uris?: string[] };
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_client_metadata", "Body must be JSON.");
  }

  const uris = body.redirect_uris ?? [];
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return badRequest("invalid_redirect_uri", "Give between 1 and 10 redirect_uris.");
  }
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return badRequest("invalid_redirect_uri", `${uri} is not a URL.`);
    }
    // http is allowed only on loopback, where there is no network to intercept
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      return badRequest(
        "invalid_redirect_uri",
        `${uri} must use https, or http on localhost.`
      );
    }
  }

  const clientId = `munshi_${randomToken(18)}`;
  const supabase = adminClient();
  const { error } = await supabase.from("oauth_clients").insert({
    client_id: clientId,
    client_name: String(body.client_name ?? "Unnamed MCP client").slice(0, 120),
    redirect_uris: uris,
  });
  if (error) {
    return Response.json(
      { error: "server_error", error_description: error.message },
      { status: 500 }
    );
  }

  return Response.json(
    {
      client_id: clientId,
      client_name: body.client_name ?? "Unnamed MCP client",
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201, headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    },
  });
}

/**
 * The token endpoint: authorization_code and refresh_token.
 *
 * The interesting part is what it moves rather than what it checks. The
 * authorization code row carries `sealed_key` — the ledger key, sealed in the
 * user's browser to this server's public key. Exchanging the code moves that
 * sealed blob into the access token and deletes the row. From then on the key
 * travels with the client and is opened for the length of one request
 * (docs/MCP.md §1).
 */
import { adminClient } from "@/lib/mcp/admin";
import {
  ACCESS_TTL_SECONDS,
  hashSecret,
  mintToken,
  readToken,
  verifyPkce,
} from "@/lib/mcp/tokens";

function fail(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) return fail("invalid_request", "Send form-encoded parameters.");

  const grant = String(form.get("grant_type") ?? "");
  const supabase = adminClient();

  if (grant === "authorization_code") {
    const code = String(form.get("code") ?? "");
    const verifier = String(form.get("code_verifier") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    if (!code || !verifier || !clientId) {
      return fail("invalid_request", "code, code_verifier and client_id are required.");
    }

    const { data: row } = await supabase
      .from("oauth_codes")
      .select("*")
      .eq("code_hash", hashSecret(code))
      .maybeSingle();
    if (!row) return fail("invalid_grant", "That code is not valid.");

    // one use, whatever happens next: delete before validating the rest, so a
    // failed exchange cannot be retried against a still-live row
    await supabase.from("oauth_codes").delete().eq("code_hash", row.code_hash);

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return fail("invalid_grant", "That code has expired.");
    }
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return fail("invalid_grant", "This code was issued to a different client.");
    }
    if (!verifyPkce(verifier, row.code_challenge)) {
      return fail("invalid_grant", "PKCE verification failed.");
    }

    return issue({
      sub: row.user_id,
      ledgerId: row.ledger_id,
      sealedKey: row.sealed_key,
      scope: row.scope,
    });
  }

  if (grant === "refresh_token") {
    const token = String(form.get("refresh_token") ?? "");
    const claims = await readToken(token, "refresh");
    if (!claims) return fail("invalid_grant", "That refresh token is not valid.");

    const { data: revoked } = await supabase
      .from("oauth_revocations")
      .select("jti")
      .eq("jti", claims.jti)
      .maybeSingle();
    if (revoked) return fail("invalid_grant", "That refresh token was revoked.");

    // the same sealed key is carried forward: refreshing must not silently
    // extend access to a book the user never re-unlocked
    return issue({
      sub: claims.sub,
      ledgerId: claims.ledger_id,
      sealedKey: claims.skey,
      scope: claims.scope,
      refreshJti: claims.jti,
    });
  }

  return fail("unsupported_grant_type", `${grant || "(none)"} is not supported.`);
}

async function issue(input: {
  sub: string;
  ledgerId: string;
  sealedKey: string;
  scope: string;
  refreshJti?: string;
}) {
  const access = await mintToken({
    sub: input.sub,
    ledger_id: input.ledgerId,
    skey: input.sealedKey,
    scope: input.scope,
    typ: "access",
  });
  const refresh = await mintToken({
    sub: input.sub,
    ledger_id: input.ledgerId,
    skey: input.sealedKey,
    scope: input.scope,
    typ: "refresh",
    // kept stable across refreshes so one revocation kills the whole chain
    jti: input.refreshJti,
  });

  return Response.json(
    {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh.token,
      scope: input.scope,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    }
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

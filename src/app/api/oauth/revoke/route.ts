/**
 * RFC 7009 revocation.
 *
 * Tokens are self-contained, so revoking one means writing down that it no
 * longer counts. Only refresh tokens are worth recording: an access token
 * lives an hour, and a revocation row for it would outlive its usefulness by
 * a month. Revoking the refresh token ends the session at the next renewal,
 * and rotating MCP_SEAL_* ends every session immediately.
 */
import { adminClient } from "@/lib/mcp/admin";
import { readToken } from "@/lib/mcp/tokens";

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const token = form ? String(form.get("token") ?? "") : "";

  const claims = (await readToken(token, "refresh")) ?? (await readToken(token, "access"));
  if (claims?.typ === "refresh") {
    const supabase = adminClient();
    await supabase.from("oauth_revocations").upsert({
      jti: claims.jti,
      user_id: claims.sub,
      expires_at: new Date(claims.exp * 1000).toISOString(),
    });
  }

  // RFC 7009: an unknown or already-invalid token is still a success, so that
  // a client cannot use this endpoint to probe which tokens exist
  return new Response(null, {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
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

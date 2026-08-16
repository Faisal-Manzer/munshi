/**
 * RFC 8414 metadata: how a client discovers this authorization server.
 *
 * Advertised deliberately narrowly — authorization code with PKCE S256, public
 * clients only. There is no implicit flow, no password grant, and no `plain`
 * challenge method, because every one of those would let a token be issued
 * without the browser step that unlocks the ledger key (docs/MCP.md §1).
 */
export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      revocation_endpoint: `${origin}/api/oauth/revoke`,
      scopes_supported: ["ledger:read", "ledger:write"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      service_documentation: `${origin}/docs/mcp`,
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } }
  );
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

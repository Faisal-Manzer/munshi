/**
 * RFC 9728: the MCP endpoint pointing at the authorization server that issues
 * tokens for it. Both live on this origin — the app is its own AS.
 *
 * The origin is taken from the request rather than from configuration, because
 * a hard-coded production URL sends a client developing against localhost off
 * to fetch metadata from the live deployment, where its client_id does not
 * exist. Proxy headers win when present, since that is the public name.
 */
function publicOrigin(request: Request): string {
  const headers = request.headers;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  const proto = headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}

export function GET(request: Request) {
  const origin = publicOrigin(request);
  return Response.json(
    {
      resource: origin,
      authorization_servers: [origin],
      scopes_supported: ["ledger:read", "ledger:write"],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/docs/mcp`,
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

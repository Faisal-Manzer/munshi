/**
 * The consent screen — where the trade this design makes is actually made.
 *
 * Three things happen on one page, in this order: the user sees who is asking,
 * picks which book to expose, and unlocks it. The unlock runs in the browser,
 * so the passphrase never reaches the server; what leaves is the ledger key,
 * sealed to the server's public key (docs/MCP.md §1).
 *
 * The warning on this page is not decoration. Connecting an MCP client is a
 * per-user, opt-in downgrade of the product's central promise, and the only
 * honest place to say so is before it happens.
 */
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { adminClient, ledgersFor } from "@/lib/mcp/admin";
import { mcpConfigured, sealPublicKey } from "@/lib/mcp/server-keys";
import { VaultProvider } from "@/lib/e2ee/vault-context";
import { ConsentForm } from "./consent-form";

export const dynamic = "force-dynamic";

interface Params {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
}

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="max-w-lg mx-auto px-6 py-16 space-y-3">
      <h1 className="text-lg">{title}</h1>
      <p className="text-sm text-ink-faint">{detail}</p>
    </main>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;

  if (!mcpConfigured()) {
    return (
      <Problem
        title="MCP is not configured on this deployment"
        detail="The server keys for the MCP endpoint are missing, so no client can be connected here."
      />
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // come back to exactly this authorization request after signing in
    const back = new URLSearchParams(params as Record<string, string>).toString();
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${back}`)}`);
  }

  if (params.response_type !== "code") {
    return <Problem title="Unsupported request" detail="Only the authorization code flow is supported." />;
  }
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return (
      <Problem
        title="This client is not using PKCE"
        detail="Munshi issues tokens only to clients that prove possession with PKCE (S256)."
      />
    );
  }

  const admin = adminClient();
  const { data: client } = await admin
    .from("oauth_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", params.client_id ?? "")
    .maybeSingle();
  if (!client) {
    return <Problem title="Unknown client" detail="This client is not registered with Munshi." />;
  }
  if (!params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri)) {
    // never redirect to an unregistered URI, not even to report the error
    return (
      <Problem
        title="Redirect mismatch"
        detail="The client asked to be sent somewhere it did not register."
      />
    );
  }

  const ledgers = await ledgersFor(admin, user.email ?? null);
  if (ledgers.length === 0) {
    return <Problem title="No books to connect" detail="This account cannot open any ledger." />;
  }

  return (
    <VaultProvider>
      <ConsentForm
        clientName={client.client_name}
        clientId={client.client_id}
        redirectUri={params.redirect_uri}
        state={params.state ?? null}
        codeChallenge={params.code_challenge}
        scope={params.scope ?? "ledger:read ledger:write"}
        ledgers={ledgers}
        serverPublicKey={sealPublicKey()}
        email={user.email ?? ""}
      />
    </VaultProvider>
  );
}

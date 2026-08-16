"use client";

/**
 * Consent, ledger choice and unlock, in one pass.
 *
 * The passphrase is turned into a key here and stays here. What crosses the
 * wire is `seal(ledgerKey, serverPublicKey)` — a blob only this deployment's
 * private key opens — and the server never learns the passphrase, which is
 * what keeps a stolen database useless (docs/MCP.md §1).
 */
import { useState } from "react";
import { useVault } from "@/lib/e2ee/vault-context";
import { loadLedgerKeys } from "@/lib/e2ee/key-store";
import { vaultWorker } from "@/lib/e2ee/worker-client";
import { createClient } from "@/lib/supabase/client";
import { seal, unwrapLedgerKey, wipe } from "@munshi/crypto";
import type { LedgerAccess } from "@/lib/mcp/admin";

export function ConsentForm({
  clientName,
  clientId,
  redirectUri,
  state,
  codeChallenge,
  scope,
  ledgers,
  serverPublicKey,
  email,
}: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  ledgers: LedgerAccess[];
  serverPublicKey: string;
  email: string;
}) {
  const { status, identity, record } = useVault();
  const [ledgerId, setLedgerId] = useState(ledgers[0]?.ledgerId ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsPassphrase = status === "locked";

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Signed out. Sign in and try again.");

      const records = await loadLedgerKeys(supabase, user.id);
      const mine = records
        .filter((r) => r.ledgerId === ledgerId)
        .sort((a, b) => b.version - a.version)[0];
      if (!mine) {
        throw new Error(
          "This book has no encryption key yet. Open it in Munshi once, then connect again."
        );
      }
      // unlocked here rather than through the vault context: this page needs
      // the identity in hand now, and consenting to share a key with a server
      // is not consent to remember it on this device
      const id =
        identity ??
        (record
          ? await vaultWorker.unlock(record.stored, passphrase)
          : null);
      if (!id) throw new Error("This account has no vault to unlock.");
      const ledgerKey = unwrapLedgerKey(id, mine);
      const sealedKey = seal(serverPublicKey, ledgerKey);
      wipe(ledgerKey);

      const response = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          scope,
          ledger_id: ledgerId,
          sealed_key: sealedKey,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error_description ?? "Could not authorize.");

      const back = new URL(redirectUri);
      back.searchParams.set("code", body.code);
      if (state) back.searchParams.set("state", state);
      window.location.href = back.toString();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not authorize.");
      setBusy(false);
    }
  }

  function deny() {
    const back = new URL(redirectUri);
    back.searchParams.set("error", "access_denied");
    if (state) back.searchParams.set("state", state);
    window.location.href = back.toString();
  }

  const field = "border border-rule px-2 py-1.5 text-sm bg-paper-raised w-full";

  return (
    <main className="max-w-lg mx-auto px-6 py-12 space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg">Connect {clientName} to Munshi</h1>
        <p className="text-xs text-ink-faint">Signed in as {email}</p>
      </div>

      <div className="border border-rule p-3 space-y-2 text-sm">
        <p className="font-medium">Read this before you approve.</p>
        <p className="text-ink-faint">
          Munshi normally cannot read your books — your passphrase never leaves your device.
          Connecting {clientName} changes that for the book you pick below: Munshi&apos;s server
          will hold that book&apos;s key while it answers each request, so it can read every
          amount, description and account name in it.
        </p>
        <p className="text-ink-faint">
          Your passphrase still never leaves this page. You can end this at any time by revoking
          the connection, and other books stay closed.
        </p>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-ink-faint">Book to connect</span>
        <select
          className={field}
          value={ledgerId}
          onChange={(e) => setLedgerId(e.target.value)}
          disabled={busy}
        >
          {ledgers.map((l) => (
            <option key={l.ledgerId} value={l.ledgerId}>
              {l.name} ({l.role})
            </option>
          ))}
        </select>
      </label>

      {needsPassphrase && (
        <label className="block space-y-1">
          <span className="text-xs text-ink-faint">Passphrase</span>
          <input
            type="password"
            className={field}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
      )}

      {status === "absent" && (
        <p className="text-sm text-ink-faint">
          This account has no vault yet. Set up encryption in Munshi before connecting a client.
        </p>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex gap-2">
        <button
          className="border border-rule px-3 py-1.5 text-sm"
          onClick={approve}
          disabled={busy || status === "absent" || !ledgerId || (needsPassphrase && !passphrase)}
        >
          {busy ? "Connecting…" : "Approve"}
        </button>
        <button className="px-3 py-1.5 text-sm text-ink-faint" onClick={deny} disabled={busy}>
          Cancel
        </button>
      </div>
    </main>
  );
}

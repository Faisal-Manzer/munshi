import "server-only";

import type { KeyPair } from "@munshi/crypto";

/**
 * The keys the MCP server is trusted with, and the blast radius of each.
 *
 * MCP_SEAL_* is an X25519 pair. Everything sensitive that leaves this process
 * — a ledger key inside a token, a proposal's ops — is sealed to the public
 * half, so only this deployment can reopen it. Rotating the pair invalidates
 * every outstanding token and proposal at once, which is the revocation story
 * for the whole design (docs/MCP.md §0).
 *
 * MCP_JWT_SECRET signs access and refresh tokens. Leaking it lets someone mint
 * a token — but not open one, because the ledger key inside is sealed with the
 * other key. Both are needed to read a book.
 *
 * Read per call rather than at module load: a missing secret should fail the
 * request that needs it with a clear message, not take the whole app down at
 * boot, and Next evaluates modules during the build where these are absent.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Generate the MCP server keys and add them to the environment ` +
        `before enabling the MCP endpoint.`
    );
  }
  return value;
}

export function sealKeys(): KeyPair {
  return {
    publicKey: required("MCP_SEAL_PUBLIC_KEY"),
    privateKey: Buffer.from(required("MCP_SEAL_PRIVATE_KEY"), "base64"),
  };
}

/** The public half alone — the consent page needs it, and it is not a secret. */
export function sealPublicKey(): string {
  return required("MCP_SEAL_PUBLIC_KEY");
}

export function jwtSecret(): Uint8Array {
  return new TextEncoder().encode(required("MCP_JWT_SECRET"));
}

/** Present so a route can answer "is MCP configured here?" without throwing. */
export function mcpConfigured(): boolean {
  return Boolean(
    process.env.MCP_SEAL_PUBLIC_KEY &&
      process.env.MCP_SEAL_PRIVATE_KEY &&
      process.env.MCP_JWT_SECRET &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

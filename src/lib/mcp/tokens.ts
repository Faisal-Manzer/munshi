import "server-only";

import { SignJWT, jwtVerify } from "jose";
import { sha256Hex } from "@munshi/crypto";
import { jwtSecret } from "./server-keys";

/**
 * Access and refresh tokens are self-contained, because the session they
 * represent has nowhere to live: a serverless instance that handled the last
 * request will not be the one handling the next (docs/MCP.md §0).
 *
 * The ledger key rides inside as `skey` — sealed to the server's X25519 public
 * key in the user's browser, so the signing secret alone does not open it.
 * This is also the honest edge of the design: whoever holds a live access
 * token holds the ability to read that book until it expires.
 */
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

const ISSUER = "munshi";

export interface TokenClaims {
  sub: string;
  ledger_id: string;
  /** The ledger key, sealed. Opened per request and wiped after. */
  skey: string;
  scope: string;
  jti: string;
  typ: "access" | "refresh";
  exp: number;
}

export async function mintToken(
  claims: Omit<TokenClaims, "exp" | "jti"> & { jti?: string }
): Promise<{ token: string; jti: string; expiresIn: number }> {
  const jti = claims.jti ?? crypto.randomUUID();
  const expiresIn = claims.typ === "access" ? ACCESS_TTL_SECONDS : REFRESH_TTL_SECONDS;
  const token = await new SignJWT({
    ledger_id: claims.ledger_id,
    skey: claims.skey,
    scope: claims.scope,
    typ: claims.typ,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(jwtSecret());
  return { token, jti, expiresIn };
}

export async function readToken(
  token: string,
  expected: "access" | "refresh"
): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret(), { issuer: ISSUER });
    if (payload.typ !== expected) return null;
    return payload as unknown as TokenClaims;
  } catch {
    // expired, tampered, or signed by a different deployment — all the same
    // answer to the caller
    return null;
  }
}

/** Codes and tokens are stored by hash, never in full. */
export function hashSecret(value: string): string {
  return sha256Hex(new TextEncoder().encode(value));
}

export function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** PKCE S256 verification. The `plain` method is deliberately not supported. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const digest = sha256Hex(new TextEncoder().encode(verifier));
  const expected = Buffer.from(digest, "hex").toString("base64url");
  return expected === challenge;
}

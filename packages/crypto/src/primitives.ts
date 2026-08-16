/**
 * The crypto floor: bytes, AEAD, KDF, sealed boxes. Nothing here knows what a
 * ledger is — the key ladder (keys.ts) is built entirely from these.
 *
 * libsodium semantics, noble implementation: pure TypeScript, no WASM and no
 * native bindings, so the identical code runs in the browser, React Native,
 * and Node (docs/E2EE.md §2).
 */
import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";

export const KEY_BYTES = 32;
const NONCE_BYTES = 24; // XChaCha20: random nonces are safe at this width
const SALT_BYTES = 16;
const ENVELOPE_VERSION = 1;

// ---- bytes -----------------------------------------------------------------

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Constant-time equality — used on key material, never on ciphertext. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Best-effort scrub of key material once it is no longer needed. */
/** Hex sha256. Used to identify a value without storing it — MCP records which
 *  proposals were committed by hash, never by content (docs/MCP.md §5). */
export function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function wipe(...arrays: Uint8Array[]): void {
  for (const a of arrays) a.fill(0);
}

// ---- key derivation --------------------------------------------------------

export interface KdfParams {
  m: number; // memory in KiB
  t: number; // iterations
  p: number; // parallelism
  salt: string; // base64
}

/**
 * Argon2id at 64 MiB / t=3 — the ente/Bitwarden ballpark. Params travel with
 * the user record so they can be raised later without stranding old accounts.
 * Run this in a Worker: at these settings it blocks for ~0.5–1s.
 */
export const DEFAULT_KDF: Omit<KdfParams, "salt"> = { m: 64 * 1024, t: 3, p: 1 };

export function newKdfParams(): KdfParams {
  return { ...DEFAULT_KDF, salt: toBase64(randomBytes(SALT_BYTES)) };
}

export function deriveKek(passphrase: string, params: KdfParams): Uint8Array {
  return argon2id(utf8(passphrase.normalize("NFKC")), fromBase64(params.salt), {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: KEY_BYTES,
  });
}

/** Domain separation, so one key never does two jobs. */
export function subkey(key: Uint8Array, purpose: string): Uint8Array {
  return hkdf(sha256, key, undefined, utf8(purpose), KEY_BYTES);
}

// ---- authenticated encryption ---------------------------------------------

/**
 * Envelope layout: version ‖ nonce ‖ ciphertext‖tag, base64 for storage.
 * `aad` is authenticated but not encrypted — bind ledger id, epoch and
 * sequence here so the server cannot reorder or splice ops undetected.
 */
export function encrypt(key: Uint8Array, plaintext: Uint8Array, aad?: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = xchacha20poly1305(key, nonce, aad ? utf8(aad) : undefined).encrypt(plaintext);
  const out = new Uint8Array(1 + NONCE_BYTES + ct.length);
  out[0] = ENVELOPE_VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE_BYTES);
  return toBase64(out);
}

export function decrypt(key: Uint8Array, envelope: string, aad?: string): Uint8Array {
  const raw = fromBase64(envelope);
  if (raw[0] !== ENVELOPE_VERSION) {
    throw new Error(`unknown envelope version ${raw[0]}`);
  }
  const nonce = raw.subarray(1, 1 + NONCE_BYTES);
  const ct = raw.subarray(1 + NONCE_BYTES);
  // throws on a bad key or tampered ciphertext — that failure IS the
  // passphrase check; no password verifier is ever stored (Standard Notes)
  return xchacha20poly1305(key, nonce, aad ? utf8(aad) : undefined).decrypt(ct);
}

// ---- sealed box (anonymous public-key encryption) --------------------------

export interface KeyPair {
  publicKey: string;  // base64, stored in the clear
  privateKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  return { publicKey: toBase64(x25519.getPublicKey(privateKey)), privateKey };
}

/**
 * Seal to a public key without revealing the sender: an ephemeral keypair does
 * one X25519 exchange, the shared secret is bound to both public keys via
 * HKDF, and the ephemeral public key rides along with the envelope.
 * This is how a ledger key reaches a new member — or the MCP service.
 */
export function seal(recipientPublicKey: string, plaintext: Uint8Array): string {
  const recipient = fromBase64(recipientPublicKey);
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, recipient);
  const key = hkdf(sha256, shared, concat(ephPub, recipient), utf8("munshi/seal"), KEY_BYTES);
  const envelope = fromBase64(encrypt(key, plaintext));
  wipe(eph, shared, key);
  return toBase64(concat(ephPub, envelope));
}

export function openSealed(pair: KeyPair, sealed: string): Uint8Array {
  const raw = fromBase64(sealed);
  const ephPub = raw.subarray(0, KEY_BYTES);
  const envelope = raw.subarray(KEY_BYTES);
  const shared = x25519.getSharedSecret(pair.privateKey, ephPub);
  const key = hkdf(
    sha256, shared, concat(ephPub, fromBase64(pair.publicKey)),
    utf8("munshi/seal"), KEY_BYTES
  );
  const out = decrypt(key, toBase64(envelope));
  wipe(shared, key);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

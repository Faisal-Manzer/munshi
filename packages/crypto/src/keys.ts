/**
 * The key ladder (docs/E2EE.md §2).
 *
 *   passphrase ──argon2id──▶ KEK                       never leaves the device
 *   KEK ──XChaCha20-Poly1305──▶ encryptedMasterKey     stored on the server
 *   masterKey ─┬─▶ wraps the X25519 private key        (public key in the clear)
 *              ├─▶ wraps the recovery key             (mutual: each wraps the other)
 *              └─▶ wraps each ledger key
 *   ledgerKey ──▶ encrypts every op, snapshot and rollup for that ledger
 *
 * The masterKey is the only thing that must survive; every unlock method is
 * just another wrapping of those same 32 bytes. That indirection is why
 * changing a passphrase rewrites 32 bytes instead of re-encrypting a ledger,
 * and why passkeys can be added later without touching stored data.
 */
import {
  KEY_BYTES,
  type KdfParams,
  type KeyPair,
  decrypt,
  deriveKek,
  encrypt,
  fromBase64,
  generateKeyPair,
  newKdfParams,
  openSealed,
  randomBytes,
  seal,
  toBase64,
  wipe,
} from "./primitives";

/** Everything about a user's keys that the server is allowed to hold. */
export interface StoredIdentity {
  kdf: KdfParams;
  /** masterKey wrapped by the passphrase-derived KEK */
  encryptedMasterKey: string;
  /** masterKey wrapped by the recovery key — the passphrase-loss escape hatch */
  masterKeyByRecovery: string;
  /** recovery key wrapped by the masterKey — lets an unlocked session re-show the kit */
  recoveryKeyByMaster: string;
  publicKey: string;
  /** X25519 private key wrapped by the masterKey */
  encryptedPrivateKey: string;
}

/** An unlocked session. Lives in memory only — never persisted as-is. */
export interface Identity {
  masterKey: Uint8Array;
  keyPair: KeyPair;
}

const AAD = {
  master: "munshi/master-key",
  masterByRecovery: "munshi/master-key/recovery",
  recovery: "munshi/recovery-key",
  privateKey: "munshi/private-key",
  ledgerKey: "munshi/ledger-key",
  deviceKey: "munshi/device-key",
} as const;

export interface NewIdentity {
  stored: StoredIdentity;
  identity: Identity;
  /** Show once, at setup. The only way back in if the passphrase is lost. */
  recoveryKey: Uint8Array;
}

/**
 * Create a brand-new identity. The caller must surface `recoveryKey` (as a
 * mnemonic, see recovery.ts) before it goes out of scope — losing both it and
 * the passphrase means the data is unrecoverable, by design.
 */
export function createIdentity(
  passphrase: string,
  /** Weaker params for tests and benchmarks; production always uses DEFAULT_KDF. */
  kdfOverride?: Partial<Omit<KdfParams, "salt">>
): NewIdentity {
  const kdf = { ...newKdfParams(), ...kdfOverride };
  const kek = deriveKek(passphrase, kdf);
  const masterKey = randomBytes(KEY_BYTES);
  const recoveryKey = randomBytes(KEY_BYTES);
  const keyPair = generateKeyPair();

  const stored: StoredIdentity = {
    kdf,
    encryptedMasterKey: encrypt(kek, masterKey, AAD.master),
    masterKeyByRecovery: encrypt(recoveryKey, masterKey, AAD.masterByRecovery),
    recoveryKeyByMaster: encrypt(masterKey, recoveryKey, AAD.recovery),
    publicKey: keyPair.publicKey,
    encryptedPrivateKey: encrypt(masterKey, keyPair.privateKey, AAD.privateKey),
  };
  wipe(kek);
  return { stored, identity: { masterKey, keyPair }, recoveryKey };
}

/**
 * Unlock with the passphrase. A wrong passphrase fails the AEAD tag check —
 * that failure is the whole verification story, so no password verifier or
 * hash is ever stored anywhere.
 */
export function unlockWithPassphrase(stored: StoredIdentity, passphrase: string): Identity {
  const kek = deriveKek(passphrase, stored.kdf);
  try {
    return openIdentity(stored, decrypt(kek, stored.encryptedMasterKey, AAD.master));
  } catch {
    throw new WrongPassphraseError();
  } finally {
    wipe(kek);
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("That passphrase does not open this account.");
    this.name = "WrongPassphraseError";
  }
}

/** Unlock with the recovery key (from the mnemonic or the printed kit). */
export function unlockWithRecoveryKey(stored: StoredIdentity, recoveryKey: Uint8Array): Identity {
  try {
    return openIdentity(
      stored,
      decrypt(recoveryKey, stored.masterKeyByRecovery, AAD.masterByRecovery)
    );
  } catch {
    throw new Error("That recovery key does not open this account.");
  }
}

function openIdentity(stored: StoredIdentity, masterKey: Uint8Array): Identity {
  const privateKey = decrypt(masterKey, stored.encryptedPrivateKey, AAD.privateKey);
  return { masterKey, keyPair: { publicKey: stored.publicKey, privateKey } };
}

/** Re-read the recovery key from an unlocked session, to re-show the kit. */
export function revealRecoveryKey(stored: StoredIdentity, identity: Identity): Uint8Array {
  return decrypt(identity.masterKey, stored.recoveryKeyByMaster, AAD.recovery);
}

/**
 * Change the passphrase: rewrap 32 bytes under a fresh salt. No ledger data is
 * touched, so this stays instant no matter how large the books are.
 */
export function changePassphrase(
  stored: StoredIdentity,
  identity: Identity,
  newPassphrase: string
): StoredIdentity {
  const kdf = newKdfParams();
  const kek = deriveKek(newPassphrase, kdf);
  const next: StoredIdentity = {
    ...stored,
    kdf,
    encryptedMasterKey: encrypt(kek, identity.masterKey, AAD.master),
  };
  wipe(kek);
  return next;
}

/**
 * Rotate the recovery key — invalidates every previously printed kit, which is
 * the point after a kit is lost or shared by mistake.
 */
export function rotateRecoveryKey(
  stored: StoredIdentity,
  identity: Identity
): { stored: StoredIdentity; recoveryKey: Uint8Array } {
  const recoveryKey = randomBytes(KEY_BYTES);
  return {
    stored: {
      ...stored,
      masterKeyByRecovery: encrypt(recoveryKey, identity.masterKey, AAD.masterByRecovery),
      recoveryKeyByMaster: encrypt(identity.masterKey, recoveryKey, AAD.recovery),
    },
    recoveryKey,
  };
}

// ---- device unlock ---------------------------------------------------------

/**
 * Silent unlock: the masterKey wrapped by a key the device holds — a
 * non-extractable WebCrypto key on the web, the OS keychain on mobile. XSS can
 * use such a key but cannot exfiltrate it; "forget this device" deletes the
 * wrapped copy. The passphrase-wrapped server copy stays the anchor.
 */
export function wrapForDevice(identity: Identity, deviceKey: Uint8Array): string {
  return encrypt(deviceKey, identity.masterKey, AAD.deviceKey);
}

export function unlockWithDeviceKey(
  stored: StoredIdentity,
  wrapped: string,
  deviceKey: Uint8Array
): Identity {
  return openIdentity(stored, decrypt(deviceKey, wrapped, AAD.deviceKey));
}

// ---- ledger keys -----------------------------------------------------------

/** One symmetric key per ledger, versioned so revocation can rotate forward. */
export interface LedgerKeyRecord {
  ledgerId: string;
  version: number;
  /** ledgerKey wrapped by this member's masterKey */
  encryptedKey: string;
}

export function createLedgerKey(
  identity: Identity,
  ledgerId: string,
  version = 1
): { record: LedgerKeyRecord; ledgerKey: Uint8Array } {
  const ledgerKey = randomBytes(KEY_BYTES);
  return { record: wrapLedgerKey(identity, ledgerId, version, ledgerKey), ledgerKey };
}

export function wrapLedgerKey(
  identity: Identity,
  ledgerId: string,
  version: number,
  ledgerKey: Uint8Array
): LedgerKeyRecord {
  return {
    ledgerId,
    version,
    encryptedKey: encrypt(identity.masterKey, ledgerKey, ledgerAad(ledgerId, version)),
  };
}

export function unwrapLedgerKey(identity: Identity, record: LedgerKeyRecord): Uint8Array {
  return decrypt(
    identity.masterKey,
    record.encryptedKey,
    ledgerAad(record.ledgerId, record.version)
  );
}

function ledgerAad(ledgerId: string, version: number): string {
  return `${AAD.ledgerKey}/${ledgerId}/v${version}`;
}

/**
 * Grant a ledger to someone holding only a public key: a new member, or the
 * MCP service at OAuth consent time (docs/E2EE.md §6.1). Mechanically the same
 * operation either way — which is exactly why the consent screen can be honest
 * about what it hands over.
 */
export function sealLedgerKeyTo(recipientPublicKey: string, ledgerKey: Uint8Array): string {
  return seal(recipientPublicKey, ledgerKey);
}

export function openSealedLedgerKey(identity: Identity, sealed: string): Uint8Array {
  return openSealed(identity.keyPair, sealed);
}

// re-exported so callers never import two packages for one flow
export { fromBase64, toBase64 };

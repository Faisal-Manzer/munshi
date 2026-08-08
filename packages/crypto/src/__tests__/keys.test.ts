import { describe, expect, it } from "vitest";
import {
  WrongPassphraseError,
  bytesEqual,
  changePassphrase,
  createIdentity,
  DEFAULT_KDF,
  createLedgerKey,
  decrypt,
  encrypt,
  fromBase64,
  generateKeyPair,
  isCompleteMnemonic,
  mnemonicToRecoveryKey,
  openSealed,
  openSealedLedgerKey,
  randomBytes,
  recoveryKeyToMnemonic,
  revealRecoveryKey,
  rotateRecoveryKey,
  seal,
  sealLedgerKeyTo,
  subkey,
  toBase64,
  unlockWithDeviceKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  unwrapLedgerKey,
  wrapForDevice,
} from "@munshi/crypto";

// The real KDF is deliberately slow (64 MiB, t=3). These tests exercise the
// ladder, not Argon2's cost, so identities are created with weakened params —
// every unlock path reads them back from the stored record, so the ladder
// under test is unchanged.
const FAST = { m: 512, t: 1, p: 1 };
const newIdentity = (passphrase: string) => createIdentity(passphrase, FAST);

const PASSPHRASE = "correct horse battery staple";

describe("envelope encryption", () => {
  it("round-trips and authenticates the AAD", () => {
    const key = randomBytes(32);
    const msg = new TextEncoder().encode("₹9,173.63 to Faraz");
    const env = encrypt(key, msg, "ledger-1/v1");
    expect(decrypt(key, env, "ledger-1/v1")).toEqual(msg);
    expect(() => decrypt(key, env, "ledger-2/v1")).toThrow();
    expect(() => decrypt(randomBytes(32), env, "ledger-1/v1")).toThrow();
  });

  it("never repeats a ciphertext for the same plaintext", () => {
    const key = randomBytes(32);
    const msg = new TextEncoder().encode("same");
    expect(encrypt(key, msg)).not.toBe(encrypt(key, msg));
  });

  it("rejects a tampered envelope", () => {
    const key = randomBytes(32);
    const raw = fromBase64(encrypt(key, new TextEncoder().encode("hello")));
    raw[raw.length - 1] ^= 1;
    expect(() => decrypt(key, toBase64(raw))).toThrow();
  });

  it("derives independent subkeys per purpose", () => {
    const key = randomBytes(32);
    expect(bytesEqual(subkey(key, "a"), subkey(key, "a"))).toBe(true);
    expect(bytesEqual(subkey(key, "a"), subkey(key, "b"))).toBe(false);
  });
});

describe("sealed box", () => {
  it("lets a public key alone encrypt, and only the private key open", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const secret = randomBytes(32);
    const sealed = seal(alice.publicKey, secret);
    expect(bytesEqual(openSealed(alice, sealed), secret)).toBe(true);
    expect(() => openSealed(bob, sealed)).toThrow();
  });

  it("is anonymous — two seals of the same secret differ", () => {
    const alice = generateKeyPair();
    const secret = randomBytes(32);
    expect(seal(alice.publicKey, secret)).not.toBe(seal(alice.publicKey, secret));
  });
});

describe("identity", () => {
  it("unlocks with the right passphrase and refuses the wrong one", () => {
    const { stored, identity } = newIdentity(PASSPHRASE);
    const reopened = unlockWithPassphrase(stored, PASSPHRASE);
    expect(bytesEqual(reopened.masterKey, identity.masterKey)).toBe(true);
    expect(bytesEqual(reopened.keyPair.privateKey, identity.keyPair.privateKey)).toBe(true);
    expect(() => unlockWithPassphrase(stored, "wrong")).toThrow(WrongPassphraseError);
  });

  it("stores no plaintext key material", () => {
    const { stored, identity } = newIdentity(PASSPHRASE);
    const blob = JSON.stringify(stored);
    expect(blob).not.toContain(toBase64(identity.masterKey));
    expect(blob).not.toContain(toBase64(identity.keyPair.privateKey));
    // the public key is meant to be readable
    expect(blob).toContain(stored.publicKey);
  });

  it("unlocks with the recovery key when the passphrase is gone", () => {
    const { stored, identity, recoveryKey } = newIdentity(PASSPHRASE);
    const reopened = unlockWithRecoveryKey(stored, recoveryKey);
    expect(bytesEqual(reopened.masterKey, identity.masterKey)).toBe(true);
    expect(() => unlockWithRecoveryKey(stored, randomBytes(32))).toThrow();
  });

  it("re-shows the recovery key from an unlocked session", () => {
    const { stored, identity, recoveryKey } = newIdentity(PASSPHRASE);
    expect(bytesEqual(revealRecoveryKey(stored, identity), recoveryKey)).toBe(true);
  });

  it("changes the passphrase without touching the master key", () => {
    const { stored, identity } = newIdentity(PASSPHRASE);
    const next = changePassphrase(stored, identity, "a brand new secret");
    expect(bytesEqual(unlockWithPassphrase(next, "a brand new secret").masterKey, identity.masterKey)).toBe(true);
    expect(() => unlockWithPassphrase(next, PASSPHRASE)).toThrow(WrongPassphraseError);
    // the salt moves, so the old KEK is worthless even against the old blob
    expect(next.kdf.salt).not.toBe(stored.kdf.salt);
  });

  it("keeps every other wrapping valid after a passphrase change", () => {
    const { stored, identity, recoveryKey } = newIdentity(PASSPHRASE);
    const next = changePassphrase(stored, identity, "new one");
    expect(bytesEqual(unlockWithRecoveryKey(next, recoveryKey).masterKey, identity.masterKey)).toBe(true);
  });

  it("rotates the recovery key, invalidating the old kit", () => {
    const { stored, identity, recoveryKey } = newIdentity(PASSPHRASE);
    const { stored: next, recoveryKey: fresh } = rotateRecoveryKey(stored, identity);
    expect(bytesEqual(unlockWithRecoveryKey(next, fresh).masterKey, identity.masterKey)).toBe(true);
    expect(() => unlockWithRecoveryKey(next, recoveryKey)).toThrow();
    expect(bytesEqual(unlockWithPassphrase(next, PASSPHRASE).masterKey, identity.masterKey)).toBe(true);
  });
});

describe("production KDF", () => {
  it("round-trips at the real 64 MiB / t=3 settings", () => {
    // the only test that pays Argon2's real cost — proves the shipped
    // parameters actually work in this runtime, not just the weakened ones
    const { stored, identity } = createIdentity(PASSPHRASE);
    expect(stored.kdf).toMatchObject(DEFAULT_KDF);
    expect(bytesEqual(unlockWithPassphrase(stored, PASSPHRASE).masterKey, identity.masterKey)).toBe(true);
  });
});

describe("device unlock", () => {
  it("opens silently with the device key and fails with another device's", () => {
    const { stored, identity } = newIdentity(PASSPHRASE);
    const deviceKey = randomBytes(32);
    const wrapped = wrapForDevice(identity, deviceKey);
    expect(bytesEqual(unlockWithDeviceKey(stored, wrapped, deviceKey).masterKey, identity.masterKey)).toBe(true);
    expect(() => unlockWithDeviceKey(stored, wrapped, randomBytes(32))).toThrow();
  });
});

describe("ledger keys", () => {
  it("wraps and unwraps per ledger", () => {
    const { identity } = newIdentity(PASSPHRASE);
    const { record, ledgerKey } = createLedgerKey(identity, "ledger-1");
    expect(bytesEqual(unwrapLedgerKey(identity, record), ledgerKey)).toBe(true);
  });

  it("binds the wrapping to the ledger id and version", () => {
    const { identity } = newIdentity(PASSPHRASE);
    const { record } = createLedgerKey(identity, "ledger-1", 1);
    expect(() => unwrapLedgerKey(identity, { ...record, ledgerId: "ledger-2" })).toThrow();
    expect(() => unwrapLedgerKey(identity, { ...record, version: 2 })).toThrow();
  });

  it("is opaque to another user's master key", () => {
    const a = newIdentity(PASSPHRASE);
    const b = newIdentity("someone else entirely");
    const { record } = createLedgerKey(a.identity, "ledger-1");
    expect(() => unwrapLedgerKey(b.identity, record)).toThrow();
  });

  it("grants a ledger to a member holding only a public key", () => {
    const owner = newIdentity(PASSPHRASE);
    const member = newIdentity("member passphrase");
    const { ledgerKey } = createLedgerKey(owner.identity, "ledger-1");

    // owner seals to the member's published public key — no shared secret,
    // no round trip; this is also the MCP consent grant
    const sealed = sealLedgerKeyTo(member.stored.publicKey, ledgerKey);
    expect(bytesEqual(openSealedLedgerKey(member.identity, sealed), ledgerKey)).toBe(true);

    const outsider = newIdentity("not invited");
    expect(() => openSealedLedgerKey(outsider.identity, sealed)).toThrow();
  });

  it("a revoked member's old key cannot open the next version", () => {
    const owner = newIdentity(PASSPHRASE);
    const v1 = createLedgerKey(owner.identity, "ledger-1", 1);
    const v2 = createLedgerKey(owner.identity, "ledger-1", 2);
    const entry = encrypt(v2.ledgerKey, new TextEncoder().encode("rent 24000"));
    expect(() => decrypt(v1.ledgerKey, entry)).toThrow();
  });
});

describe("recovery mnemonic", () => {
  it("round-trips 32 bytes through 24 words", () => {
    const key = randomBytes(32);
    const words = recoveryKeyToMnemonic(key);
    expect(words.split(" ")).toHaveLength(24);
    expect(bytesEqual(mnemonicToRecoveryKey(words), key)).toBe(true);
  });

  it("survives sloppy transcription", () => {
    const key = randomBytes(32);
    const words = recoveryKeyToMnemonic(key);
    const messy = `  ${words.toUpperCase().split(" ").join(",\n")}  `;
    expect(bytesEqual(mnemonicToRecoveryKey(messy), key)).toBe(true);
  });

  it("catches a typo via the checksum instead of failing at decrypt", () => {
    const words = recoveryKeyToMnemonic(randomBytes(32)).split(" ");
    words[3] = words[3] === "zoo" ? "zone" : "zoo";
    expect(isCompleteMnemonic(words.join(" "))).toBe(false);
    expect(() => mnemonicToRecoveryKey(words.join(" "))).toThrow();
  });

  it("knows when the user has finished typing", () => {
    const words = recoveryKeyToMnemonic(randomBytes(32));
    expect(isCompleteMnemonic(words.split(" ").slice(0, 23).join(" "))).toBe(false);
    expect(isCompleteMnemonic(words)).toBe(true);
  });

  it("opens a real identity end to end from words alone", () => {
    const { stored, identity, recoveryKey } = newIdentity(PASSPHRASE);
    const words = recoveryKeyToMnemonic(recoveryKey);
    const recovered = unlockWithRecoveryKey(stored, mnemonicToRecoveryKey(words));
    expect(bytesEqual(recovered.masterKey, identity.masterKey)).toBe(true);
  });
});

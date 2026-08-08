/**
 * Argon2id at 64 MiB blocks its thread for ~0.5–1s, which on the main thread
 * means a frozen tab at exactly the moment the user is deciding whether to
 * trust us. So every passphrase operation runs here (docs/E2EE.md §2).
 *
 * Only key material crosses the boundary — never ledger data. The passphrase
 * enters, a wrapped/unwrapped key comes back, and the worker holds nothing.
 */
import {
  changePassphrase,
  createIdentity,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type Identity,
  type StoredIdentity,
} from "@munshi/crypto";

export type VaultRequest =
  | { id: number; op: "create"; passphrase: string }
  | { id: number; op: "unlock"; stored: StoredIdentity; passphrase: string }
  | { id: number; op: "unlockRecovery"; stored: StoredIdentity; recoveryKey: Uint8Array }
  | { id: number; op: "changePassphrase"; stored: StoredIdentity; identity: Identity; passphrase: string };

export type VaultResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; name: string };

self.onmessage = (e: MessageEvent<VaultRequest>) => {
  const req = e.data;
  try {
    let result: unknown;
    switch (req.op) {
      case "create":
        result = createIdentity(req.passphrase);
        break;
      case "unlock":
        result = unlockWithPassphrase(req.stored, req.passphrase);
        break;
      case "unlockRecovery":
        result = unlockWithRecoveryKey(req.stored, req.recoveryKey);
        break;
      case "changePassphrase":
        result = changePassphrase(req.stored, req.identity, req.passphrase);
        break;
    }
    self.postMessage({ id: req.id, ok: true, result } satisfies VaultResponse);
  } catch (err) {
    self.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : "failed",
      name: err instanceof Error ? err.name : "Error",
    } satisfies VaultResponse);
  }
};

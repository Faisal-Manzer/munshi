/**
 * Typed caller for vault.worker.ts. One worker is reused across calls: the
 * first passphrase prompt pays the module load, later ones are just Argon2.
 */
import type { Identity, NewIdentity, StoredIdentity } from "@munshi/crypto";
import type { VaultRequest, VaultResponse } from "./vault.worker";

/** Omit over a union must distribute, or each variant loses its own fields. */
type Request = VaultRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  worker ??= new Worker(new URL("./vault.worker.ts", import.meta.url), { type: "module" });
  return worker;
}

function call<T>(req: Request): Promise<T> {
  const w = getWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const onMessage = (e: MessageEvent<VaultResponse>) => {
      if (e.data.id !== id) return;
      w.removeEventListener("message", onMessage);
      if (e.data.ok) {
        resolve(e.data.result as T);
      } else {
        const err = new Error(e.data.error);
        err.name = e.data.name; // keeps WrongPassphraseError distinguishable
        reject(err);
      }
    };
    w.addEventListener("message", onMessage);
    w.postMessage({ ...req, id } as VaultRequest);
  });
}

export const vaultWorker = {
  create: (passphrase: string) => call<NewIdentity>({ op: "create", passphrase }),
  unlock: (stored: StoredIdentity, passphrase: string) =>
    call<Identity>({ op: "unlock", stored, passphrase }),
  unlockRecovery: (stored: StoredIdentity, recoveryKey: Uint8Array) =>
    call<Identity>({ op: "unlockRecovery", stored, recoveryKey }),
  changePassphrase: (stored: StoredIdentity, identity: Identity, passphrase: string) =>
    call<StoredIdentity>({ op: "changePassphrase", stored, identity, passphrase }),
};

"use client";

/**
 * Vault state for the whole app: is encryption set up, is it open, and the
 * in-memory identity while it is.
 *
 * The unlocked identity lives in React state and nowhere else — no
 * localStorage, no sessionStorage, no cookie. Closing the tab locks it; the
 * only thing that survives is the device-wrapped copy in IndexedDB, which the
 * browser will only decrypt with a key JS cannot read (device-key.ts).
 *
 * Nothing is encrypted yet: this phase installs the lock, phase 3 moves the
 * data behind it. So a locked vault never blocks the ledger — it just means
 * the keys aren't loaded.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import {
  forgetDevice,
  isDeviceRemembered,
  rememberDevice,
  unwrapWithDevice,
} from "@/lib/e2ee/device-key";
import {
  createVault,
  loadVault,
  markRecoveryConfirmed,
  updateVault,
  type VaultRecord,
} from "@/lib/e2ee/key-store";
import { vaultWorker } from "@/lib/e2ee/worker-client";
import {
  identityFromMasterKey,
  mnemonicToRecoveryKey,
  recoveryKeyToMnemonic,
  revealRecoveryKey,
  type Identity,
} from "@munshi/crypto";

export type VaultStatus =
  | "loading"    // still asking the server whether keys exist
  | "absent"     // encryption never set up — the ledger works as it always did
  | "locked"     // keys exist, this session hasn't opened them
  | "unlocked";

interface VaultValue {
  status: VaultStatus;
  userId: string | null;
  identity: Identity | null;
  record: VaultRecord | null;
  deviceRemembered: boolean;
  /** First-time setup. Returns the 24 words to show once, then never again. */
  setUp: (passphrase: string) => Promise<string>;
  unlock: (passphrase: string, remember: boolean) => Promise<void>;
  unlockWithWords: (mnemonic: string) => Promise<void>;
  lock: () => void;
  confirmRecoverySaved: () => Promise<void>;
  changePassphrase: (current: string, next: string) => Promise<void>;
  showRecoveryWords: () => string;
  setDeviceRemembered: (on: boolean) => Promise<void>;
}

const VaultContext = createContext<VaultValue | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [status, setStatus] = useState<VaultStatus>("loading");
  const [userId, setUserId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [record, setRecord] = useState<VaultRecord | null>(null);
  const [deviceRemembered, setRemembered] = useState(false);

  // on load: do keys exist, and can this device open them without asking?
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id ?? null;
      if (cancelled) return;
      setUserId(uid);
      if (!uid) {
        setStatus("absent");
        return;
      }
      let vault: VaultRecord | null = null;
      try {
        vault = await loadVault(supabase, uid);
      } catch {
        // a key-table failure must never take the ledger down with it
        if (!cancelled) setStatus("absent");
        return;
      }
      if (cancelled) return;
      setRecord(vault);
      if (!vault) {
        setStatus("absent");
        return;
      }
      const masterKey = await unwrapWithDevice(uid);
      if (cancelled) return;
      if (masterKey) {
        setIdentity(identityFromMasterKey(vault.stored, masterKey));
        setRemembered(true);
        setStatus("unlocked");
      } else {
        setRemembered(await isDeviceRemembered(uid));
        setStatus("locked");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const setUp = useCallback(
    async (passphrase: string) => {
      if (!userId) throw new Error("Sign in first.");
      const { stored, identity: id, recoveryKey } = await vaultWorker.create(passphrase);
      await createVault(supabase, userId, stored);
      setRecord({ stored, recoveryConfirmedAt: null });
      setIdentity(id);
      setStatus("unlocked");
      return recoveryKeyToMnemonic(recoveryKey);
    },
    [supabase, userId]
  );

  const unlock = useCallback(
    async (passphrase: string, remember: boolean) => {
      if (!record || !userId) throw new Error("No vault to unlock.");
      const id = await vaultWorker.unlock(record.stored, passphrase);
      if (remember) await rememberDevice(userId, id.masterKey);
      setRemembered(remember);
      setIdentity(id);
      setStatus("unlocked");
    },
    [record, userId]
  );

  const unlockWithWords = useCallback(
    async (mnemonic: string) => {
      if (!record) throw new Error("No vault to unlock.");
      const id = await vaultWorker.unlockRecovery(
        record.stored,
        mnemonicToRecoveryKey(mnemonic)
      );
      setIdentity(id);
      setStatus("unlocked");
    },
    [record]
  );

  const lock = useCallback(() => {
    setIdentity(null);
    setStatus(record ? "locked" : "absent");
  }, [record]);

  const confirmRecoverySaved = useCallback(async () => {
    if (!userId) return;
    await markRecoveryConfirmed(supabase, userId);
    setRecord((r) => (r ? { ...r, recoveryConfirmedAt: new Date().toISOString() } : r));
  }, [supabase, userId]);

  const changePassphrase = useCallback(
    async (current: string, next: string) => {
      if (!record || !userId) throw new Error("No vault.");
      // re-derive from the current passphrase rather than trusting the open
      // session: changing the lock should require proving you know the old one
      const id = await vaultWorker.unlock(record.stored, current);
      const stored = await vaultWorker.changePassphrase(record.stored, id, next);
      await updateVault(supabase, userId, stored);
      setRecord({ ...record, stored });
      setIdentity(id);
      if (deviceRemembered) await rememberDevice(userId, id.masterKey);
    },
    [record, supabase, userId, deviceRemembered]
  );

  const showRecoveryWords = useCallback(() => {
    if (!record || !identity) throw new Error("Unlock first.");
    return recoveryKeyToMnemonic(revealRecoveryKey(record.stored, identity));
  }, [record, identity]);

  const setDeviceRemembered = useCallback(
    async (on: boolean) => {
      if (!userId) return;
      if (on && identity) await rememberDevice(userId, identity.masterKey);
      if (!on) await forgetDevice();
      setRemembered(on);
    },
    [userId, identity]
  );

  const value: VaultValue = {
    status,
    userId,
    identity,
    record,
    deviceRemembered,
    setUp,
    unlock,
    unlockWithWords,
    lock,
    confirmRecoverySaved,
    changePassphrase,
    showRecoveryWords,
    setDeviceRemembered,
  };

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used inside VaultProvider");
  return ctx;
}

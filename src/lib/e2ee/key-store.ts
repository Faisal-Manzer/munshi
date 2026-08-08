/**
 * Reads and writes the wrapped-key rows (migration 010). Everything crossing
 * this file is an opaque envelope or deliberate metadata — there is no code
 * path here that could send plaintext to the server even by mistake.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerKeyRecord, StoredIdentity } from "@munshi/crypto";

interface UserKeysRow {
  user_id: string;
  kdf_memory_kib: number;
  kdf_iterations: number;
  kdf_parallelism: number;
  kdf_salt: string;
  encrypted_master_key: string;
  master_key_by_recovery: string;
  recovery_key_by_master: string;
  public_key: string;
  encrypted_private_key: string;
  recovery_confirmed_at: string | null;
}

function toStored(row: UserKeysRow): StoredIdentity {
  return {
    kdf: {
      m: row.kdf_memory_kib,
      t: row.kdf_iterations,
      p: row.kdf_parallelism,
      salt: row.kdf_salt,
    },
    encryptedMasterKey: row.encrypted_master_key,
    masterKeyByRecovery: row.master_key_by_recovery,
    recoveryKeyByMaster: row.recovery_key_by_master,
    publicKey: row.public_key,
    encryptedPrivateKey: row.encrypted_private_key,
  };
}

function toRow(userId: string, stored: StoredIdentity) {
  return {
    user_id: userId,
    kdf_memory_kib: stored.kdf.m,
    kdf_iterations: stored.kdf.t,
    kdf_parallelism: stored.kdf.p,
    kdf_salt: stored.kdf.salt,
    encrypted_master_key: stored.encryptedMasterKey,
    master_key_by_recovery: stored.masterKeyByRecovery,
    recovery_key_by_master: stored.recoveryKeyByMaster,
    public_key: stored.publicKey,
    encrypted_private_key: stored.encryptedPrivateKey,
  };
}

export interface VaultRecord {
  stored: StoredIdentity;
  recoveryConfirmedAt: string | null;
}

export async function loadVault(
  supabase: SupabaseClient,
  userId: string
): Promise<VaultRecord | null> {
  const { data, error } = await supabase
    .from("user_keys")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as UserKeysRow;
  return { stored: toStored(row), recoveryConfirmedAt: row.recovery_confirmed_at };
}

/** First-time setup. Insert-only: an existing row must never be overwritten,
 *  because that would strand every ledger key wrapped under the old master. */
export async function createVault(
  supabase: SupabaseClient,
  userId: string,
  stored: StoredIdentity
): Promise<void> {
  const { error } = await supabase.from("user_keys").insert(toRow(userId, stored));
  if (error) throw error;
}

/** Passphrase change / recovery rotation — rewraps 32 bytes, touches no data. */
export async function updateVault(
  supabase: SupabaseClient,
  userId: string,
  stored: StoredIdentity
): Promise<void> {
  const { error } = await supabase
    .from("user_keys")
    .update(toRow(userId, stored))
    .eq("user_id", userId);
  if (error) throw error;
}

export async function markRecoveryConfirmed(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from("user_keys")
    .update({ recovery_confirmed_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) throw error;
}

// ---- ledger keys -----------------------------------------------------------

export async function loadLedgerKeys(
  supabase: SupabaseClient,
  userId: string
): Promise<LedgerKeyRecord[]> {
  const { data, error } = await supabase
    .from("ledger_keys")
    .select("ledger_id, version, encrypted_key")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    ledgerId: r.ledger_id as string,
    version: r.version as number,
    encryptedKey: r.encrypted_key as string,
  }));
}

export async function saveLedgerKey(
  supabase: SupabaseClient,
  userId: string,
  record: LedgerKeyRecord
): Promise<void> {
  const { error } = await supabase.from("ledger_keys").insert({
    ledger_id: record.ledgerId,
    user_id: userId,
    version: record.version,
    encrypted_key: record.encryptedKey,
    granted_by: userId,
  });
  if (error) throw error;
}

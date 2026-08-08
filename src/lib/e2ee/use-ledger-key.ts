"use client";

/**
 * The active book's key, unwrapped in memory.
 *
 * Returns null when there is nothing to unwrap — no vault, vault locked, or a
 * book that was never encrypted. Callers treat null as "read and write
 * plaintext", which is what keeps an un-migrated book working normally.
 */
import { useCallback, useEffect, useState } from "react";
import { useVault } from "@/lib/e2ee/vault-context";
import { loadLedgerKeys, saveLedgerKey } from "@/lib/e2ee/key-store";
import { createLedgerKey, unwrapLedgerKey } from "@munshi/crypto";
import { createClient } from "@/lib/supabase/client";

export function useLedgerKey(ledgerId: string | null) {
  const { identity, userId, status } = useVault();
  const [key, setKey] = useState<Uint8Array | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    setReady(false);
    if (!ledgerId || !identity || !userId) {
      setKey(null);
      setReady(true);
      return;
    }
    const supabase = createClient();
    const records = await loadLedgerKeys(supabase, userId);
    // highest version wins: revocation rotates forward, and new writes always
    // use the newest key the member holds
    const mine = records
      .filter((r) => r.ledgerId === ledgerId)
      .sort((a, b) => b.version - a.version)[0];
    setKey(mine ? unwrapLedgerKey(identity, mine) : null);
    setReady(true);
  }, [ledgerId, identity, userId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Mint this book's key. Called once, when encryption is switched on. */
  const provision = useCallback(async () => {
    if (!ledgerId || !identity || !userId) throw new Error("Unlock your vault first.");
    const supabase = createClient();
    const existing = (await loadLedgerKeys(supabase, userId)).filter(
      (r) => r.ledgerId === ledgerId
    );
    if (existing.length > 0) {
      // never mint a second key for a book: rows encrypted under the first
      // one would become unreadable
      const newest = existing.sort((a, b) => b.version - a.version)[0];
      const k = unwrapLedgerKey(identity, newest);
      setKey(k);
      return k;
    }
    const { record, ledgerKey } = createLedgerKey(identity, ledgerId);
    await saveLedgerKey(supabase, userId, record);
    setKey(ledgerKey);
    return ledgerKey;
  }, [ledgerId, identity, userId]);

  return { key, ready, provision, reload: load, vaultStatus: status };
}

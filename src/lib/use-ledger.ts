"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { createSupabaseStore } from "@munshi/store";
import { useActiveLedger } from "@/lib/ledger-context";
import { useLedgerKey } from "@/lib/e2ee/use-ledger-key";
import { decryptAccount, decryptPosting, decryptTransaction } from "@munshi/store";
import { computeBalances, computeCardCycles } from "@munshi/core";
import type {
  Account,
  AccountBalance,
  CardCycle,
  LedgerData,
  Posting,
  Transaction,
} from "@munshi/core";

/**
 * Loads the active ledger and derives every number from it locally.
 *
 * Balances and card cycles used to come from the `account_balances` and
 * `card_cycle_balances` SQL views. They are computed here now, because a view
 * cannot sum an amount it cannot read — once entries are encrypted the server
 * has nothing to aggregate (docs/E2EE.md §7). The whole ledger is a few
 * hundred rows, so pulling it and folding it is cheaper than the two extra
 * round trips it replaces.
 */
export function useLedger() {
  const supabase = useMemo(() => createClient(), []);
  // every mutation goes through the store, never straight to Postgres
  const { ledgerId, ledger, ledgers, switchLedger, error: ledgerError } = useActiveLedger();
  const { key: ledgerKey, ready: keyReady, provision, reload: reloadKey } = useLedgerKey(ledgerId);
  const store = useMemo(
    () => createSupabaseStore(supabase, ledgerKey),
    [supabase, ledgerKey]
  );
  const [data, setData] = useState<LedgerData>({
    accounts: [],
    transactions: [],
    postings: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ledgerId) return;
    // wait for the key: decrypting with a null key would throw on every row
    if (!keyReady) return;
    const [accRes, txnRes, postRes] = await Promise.all([
      supabase
        .from("accounts")
        .select("*")
        .eq("ledger_id", ledgerId)
        .order("sort_order")
        .order("created_at"),
      supabase
        .from("transactions")
        .select("id, ledger_id, date, description, status, tag, notes, created_at, recurring_template_id, reimburse_account_id, reimburse_amount_paise, payload")
        .eq("ledger_id", ledgerId),
      supabase
        .from("postings")
        .select("id, transaction_id, account_id, amount_paise, payload")
        .eq("ledger_id", ledgerId),
    ]);
    const failure = accRes.error ?? txnRes.error ?? postRes.error;
    if (failure) {
      setError(failure.message);
    } else {
      try {
        setData({
          accounts: (accRes.data as Account[]).map((a) => decryptAccount(ledgerKey, a)),
          transactions: (txnRes.data as Transaction[]).map((t) => decryptTransaction(ledgerKey, t)),
          postings: (postRes.data as Posting[]).map((p) => decryptPosting(ledgerKey, p)),
        });
        setError(null);
      } catch (e) {
        // an encrypted book with no key in hand. Blank the ledger as well as
        // reporting it: leaving the last readable load on screen would show
        // decrypted entries under a "locked" banner, and any edit would then
        // be built from rows we can no longer read
        setData({ accounts: [], transactions: [], postings: [] });
        setError(e instanceof Error ? e.message : "could not decrypt this book");
      }
    }
    setLoading(false);
  }, [supabase, ledgerId, ledgerKey, keyReady]);

  useEffect(() => {
    setLoading(true); // switching books: don't show the old one's numbers
    reload();
  }, [reload]);

  const balances: Map<string, AccountBalance> = useMemo(
    () => computeBalances(data),
    [data]
  );
  const cycles: Map<string, CardCycle> = useMemo(
    // recomputed per load rather than per render: the cutoff depends on today,
    // and a tab left open overnight should pick the new one up on next reload
    () => computeCardCycles(data),
    [data]
  );

  return {
    supabase,
    store,
    ledgerId,
    ledger,
    ledgers,
    switchLedger,
    ledgerKey,
    keyReady,
    provisionLedgerKey: provision,
    reloadKey,
    accounts: data.accounts,
    transactions: data.transactions,
    postings: data.postings,
    balances,
    cycles,
    loading,
    error: error ?? ledgerError,
    reload,
  };
}

export { accountById } from "@munshi/core";

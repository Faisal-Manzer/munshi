"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { createSupabaseStore } from "@/lib/supabase-store";
import { useActiveLedger } from "@/lib/ledger-context";
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
  const store = useMemo(() => createSupabaseStore(supabase), [supabase]);
  const { ledgerId, ledger, ledgers, switchLedger, error: ledgerError } = useActiveLedger();
  const [data, setData] = useState<LedgerData>({
    accounts: [],
    transactions: [],
    postings: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ledgerId) return;
    const [accRes, txnRes, postRes] = await Promise.all([
      supabase
        .from("accounts")
        .select("*")
        .eq("ledger_id", ledgerId)
        .order("sort_order")
        .order("created_at"),
      supabase
        .from("transactions")
        .select("id, ledger_id, date, description, status, tag, notes, created_at, recurring_template_id, reimburse_account_id, reimburse_amount_paise")
        .eq("ledger_id", ledgerId),
      supabase
        .from("postings")
        .select("id, transaction_id, account_id, amount_paise")
        .eq("ledger_id", ledgerId),
    ]);
    const failure = accRes.error ?? txnRes.error ?? postRes.error;
    if (failure) {
      setError(failure.message);
    } else {
      setData({
        accounts: accRes.data as Account[],
        transactions: txnRes.data as Transaction[],
        postings: postRes.data as Posting[],
      });
      setError(null);
    }
    setLoading(false);
  }, [supabase, ledgerId]);

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

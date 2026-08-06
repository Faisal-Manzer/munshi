"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useActiveLedger } from "@/lib/ledger-context";
import type { Account, AccountBalance, CardCycle } from "@/lib/types";

/** Loads the active ledger's account tree + balances; shared by every page. */
export function useLedger() {
  const supabase = useMemo(() => createClient(), []);
  const { ledgerId, ledger, ledgers, switchLedger } = useActiveLedger();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<Map<string, AccountBalance>>(
    new Map()
  );
  const [cycles, setCycles] = useState<Map<string, CardCycle>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ledgerId) return;
    const [accRes, balRes, cycRes] = await Promise.all([
      supabase
        .from("accounts")
        .select("*")
        .eq("ledger_id", ledgerId)
        .order("sort_order")
        .order("created_at"),
      supabase.from("account_balances").select("*").eq("ledger_id", ledgerId),
      supabase.from("card_cycle_balances").select("*").eq("ledger_id", ledgerId),
    ]);
    if (accRes.error || balRes.error || cycRes.error) {
      setError(
        accRes.error?.message ??
          balRes.error?.message ??
          cycRes.error?.message ??
          "load failed"
      );
    } else {
      setAccounts(accRes.data as Account[]);
      setBalances(
        new Map(
          (balRes.data as AccountBalance[]).map((b) => [b.account_id, b])
        )
      );
      setCycles(
        new Map((cycRes.data as CardCycle[]).map((c) => [c.account_id, c]))
      );
      setError(null);
    }
    setLoading(false);
  }, [supabase, ledgerId]);

  useEffect(() => {
    setLoading(true); // switching books: don't show the old one's numbers
    reload();
  }, [reload]);

  return {
    supabase,
    ledgerId,
    ledger,
    ledgers,
    switchLedger,
    accounts,
    balances,
    cycles,
    loading,
    error,
    reload,
  };
}

export { accountById } from "./calc";

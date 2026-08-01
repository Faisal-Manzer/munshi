"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Account, AccountBalance, CardCycle } from "@/lib/types";

/** Loads the account tree + balances; shared by every page. */
export function useLedger() {
  const supabase = useMemo(() => createClient(), []);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<Map<string, AccountBalance>>(
    new Map()
  );
  const [cycles, setCycles] = useState<Map<string, CardCycle>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [accRes, balRes, cycRes] = await Promise.all([
      supabase
        .from("accounts")
        .select("*")
        .order("sort_order")
        .order("created_at"),
      supabase.from("account_balances").select("*"),
      supabase.from("card_cycle_balances").select("*"),
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
  }, [supabase]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { supabase, accounts, balances, cycles, loading, error, reload };
}

export { accountById } from "./calc";

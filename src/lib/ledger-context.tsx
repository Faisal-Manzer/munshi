"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { Ledger } from "@/lib/types";

const ACTIVE_KEY = "munshi-active-ledger";

interface LedgerContextValue {
  error: string | null;
  ledgers: Ledger[];
  ledgerId: string | null; // null until the list has loaded
  ledger: Ledger | null;
  switchLedger: (id: string) => void;
  createLedger: (name: string) => Promise<string>;
  renameLedger: (id: string, name: string) => Promise<void>;
  reloadLedgers: () => Promise<void>;
}

const LedgerContext = createContext<LedgerContextValue | null>(null);

/** Which of the user's books is on the desk. Every screen is scoped to it. */
export function LedgerProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [ledgerId, setLedgerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("ledgers")
      .select("*")
      .eq("archived", false)
      .order("sort_order")
      .order("created_at");
    if (error) throw error;
    let list = (data ?? []) as Ledger[];
    if (list.length === 0) {
      // first sign-in ever: give them a book to write in
      const { data: id, error: ce } = await supabase.rpc("ledger_create", {
        ledger_name: "Personal",
      });
      if (ce) throw ce;
      list = [{ id: id as string, name: "Personal", sort_order: 0, archived: false }];
    }
    setLedgers(list);
    setLedgerId((cur) => {
      const want = cur ?? localStorage.getItem(ACTIVE_KEY);
      return list.some((l) => l.id === want) ? (want as string) : list[0].id;
    });
  }, [supabase]);

  useEffect(() => {
    load()
      .then(() => setError(null))
      .catch((e) => setError(e instanceof Error ? e.message : "ledgers failed to load"));
  }, [load]);

  const switchLedger = useCallback((id: string) => {
    localStorage.setItem(ACTIVE_KEY, id);
    setLedgerId(id);
  }, []);

  const createLedger = useCallback(
    async (name: string) => {
      const { data, error } = await supabase.rpc("ledger_create", {
        ledger_name: name,
      });
      if (error) throw error;
      await load();
      return data as string;
    },
    [supabase, load]
  );

  const renameLedger = useCallback(
    async (id: string, name: string) => {
      const { error } = await supabase
        .from("ledgers")
        .update({ name })
        .eq("id", id);
      if (error) throw error;
      await load();
    },
    [supabase, load]
  );

  const value = useMemo(
    () => ({
      error,
      ledgers,
      ledgerId,
      ledger: ledgers.find((l) => l.id === ledgerId) ?? null,
      switchLedger,
      createLedger,
      renameLedger,
      reloadLedgers: load,
    }),
    [error, ledgers, ledgerId, switchLedger, createLedger, renameLedger, load]
  );

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}

export function useActiveLedger(): LedgerContextValue {
  const ctx = useContext(LedgerContext);
  if (!ctx) throw new Error("useActiveLedger outside LedgerProvider");
  return ctx;
}

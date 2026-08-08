"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Posting, Transaction } from "@munshi/core";
import { decryptPosting, decryptTransaction } from "@/lib/e2ee/codec";

export interface TitleSuggestion {
  title: string;
  count: number;
  fromId: string | null;
  toId: string | null;
  tag: string | null;
}

/** Distinct past entry titles with how they were last booked — for quick-add prefill. */
/**
 * Past titles, for autocompletion. Descriptions and amounts arrive as
 * ciphertext on an encrypted book, so the key has to come along; without it
 * there is simply nothing to suggest.
 */
export function useTitleSuggestions(
  supabase: SupabaseClient,
  ledgerId: string | null,
  ledgerKey: Uint8Array | null = null
): TitleSuggestion[] {
  const [list, setList] = useState<TitleSuggestion[]>([]);

  useEffect(() => {
    if (!ledgerId) return;
    supabase
      .from("transactions")
      .select("description, tag, reimburse_account_id, payload, postings(account_id, amount_paise, payload)")
      // scoped to the open book: suggestions from another ledger are both a
      // privacy leak between books and undecryptable under this book's key
      .eq("ledger_id", ledgerId)
      .order("date", { ascending: false })
      .limit(400)
      .then(({ data }) => {
        const map = new Map<string, TitleSuggestion>();
        const rows = (data ?? []) as (Transaction & { postings: Posting[] })[];
        for (const raw of rows) {
          let t: Transaction & { postings: Posting[] };
          try {
            t = {
              ...decryptTransaction(ledgerKey, raw),
              postings: raw.postings.map((p) => decryptPosting(ledgerKey, p)),
            };
          } catch {
            continue; // a row we cannot read simply does not suggest anything
          }
          const title = t.description.trim();
          if (!title || title.startsWith("Opening balance")) continue;
          const key = title.toLowerCase();
          const seen = map.get(key);
          if (seen) {
            seen.count += 1;
            continue;
          }
          const neg = t.postings.find((p) => p.amount_paise < 0);
          const pos = t.postings.find(
            (p) => p.amount_paise > 0 && p.account_id !== t.reimburse_account_id
          );
          map.set(key, {
            title,
            count: 1,
            fromId: neg?.account_id ?? null,
            toId: pos?.account_id ?? null,
            tag: t.tag,
          });
        }
        setList([...map.values()]);
      });
  }, [supabase, ledgerId, ledgerKey]);

  return list;
}

/**
 * Title field with suggestions from past entries. Free text always allowed;
 * picking a suggestion also hands back how it was last booked (accounts, tag).
 */
export function TitleInput({
  value, onChange, onPick, suggestions, placeholder, className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (s: TitleSuggestion) => void;
  suggestions: TitleSuggestion[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1); // -1 = nothing highlighted, Enter falls through to save
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const pool = q
      ? suggestions.filter((s) => s.title.toLowerCase().includes(q) && s.title.toLowerCase() !== q)
      : suggestions;
    return [...pool].sort((a, b) => b.count - a.count).slice(0, 8);
  }, [suggestions, value]);

  useLayoutEffect(() => {
    if (!open || !inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 224) });
  }, [open, matches.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (inputRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useEffect(() => setHi(-1), [value]);

  function pick(s: TitleSuggestion) {
    setOpen(false);
    setHi(-1);
    onPick(s);
  }

  return (
    <>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        className={className}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, -1));
          } else if (e.key === "Enter" && hi >= 0) {
            e.preventDefault();
            e.stopPropagation(); // don't trigger the row's Enter-saves
            pick(matches[hi]);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && matches.length > 0 && (
        <div
          ref={panelRef}
          className="fixed z-[60] border border-rule-strong bg-paper-raised shadow-xl py-1 max-h-56 overflow-y-auto"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {matches.map((s, i) => (
            <button
              key={s.title}
              type="button"
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(s)}
              className={`w-full text-left px-3 py-1 text-sm flex items-center justify-between gap-2 ${i === hi ? "bg-ledger-soft" : ""}`}
            >
              <span className="truncate">{s.title}</span>
              {s.count > 1 && <span className="text-[10px] text-ink-faint shrink-0">×{s.count}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

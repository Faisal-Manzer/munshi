"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string; // faint suffix, e.g. "·" prefix for children
}
export interface SelectGroup {
  label?: string;
  options: SelectOption[];
}

/**
 * Custom dropdown replacing native <select> — ledger-styled, keyboard-first:
 * type to filter, arrows to move, Enter selects, Escape closes.
 * Panel is fixed-positioned so it escapes overflow-x-auto table wrappers.
 */
export function Select({
  value, onChange, groups, placeholder = "—", className = "", chrome = false, disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  groups: SelectGroup[];
  placeholder?: string;
  className?: string;
  /** true = standalone form field with border; false = bare, for table cells */
  chrome?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean }>({
    top: 0, left: 0, width: 0, up: false,
  });

  const flatAll = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const selected = flatAll.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, options: g.options.filter((o) => o.label.toLowerCase().includes(q)) }))
      .filter((g) => g.options.length > 0);
  }, [groups, query]);
  const flat = useMemo(() => filtered.flatMap((g) => g.options), [filtered]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const panelH = Math.min(320, 42 + flat.length * 28);
    const up = r.bottom + panelH > window.innerHeight && r.top > panelH;
    setPos({
      top: up ? r.top - panelH - 2 : r.bottom + 2,
      left: Math.min(r.left, window.innerWidth - Math.max(r.width, 224) - 8),
      width: Math.max(r.width, 224),
      up,
    });
  }, [open, flat.length]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHi(Math.max(0, flatAll.findIndex((o) => o.value === value)));
    setTimeout(() => searchRef.current?.focus(), 10);
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setHi(0), [query]);

  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${hi}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  function pick(v: string) {
    setOpen(false);
    if (v !== value) onChange(v);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (flat[hi]) pick(flat[hi].value);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  let idx = -1;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === "ArrowDown" || e.key === " ") && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`${chrome
          ? "border border-rule px-2 py-1.5 bg-paper-raised text-sm"
          : "px-2 py-1.5 bg-transparent hover:bg-ledger-soft/40"
        } ${/(^|\s)w-/.test(className) ? "" : "w-full"} text-left flex items-center justify-between gap-1 disabled:opacity-50 ${className}`}
      >
        <span className={`truncate ${selected ? "" : "text-ink-faint"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={12} className="shrink-0 text-ink-faint" />
      </button>
      {open && (
        <div
          ref={panelRef}
          onKeyDown={onKey}
          className="fixed z-[60] border border-rule-strong bg-paper-raised shadow-xl"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to filter…"
            className="w-full px-3 py-2 text-xs border-b border-rule bg-paper-raised"
          />
          <div className="max-h-[276px] overflow-y-auto py-1">
            {filtered.map((g, gi) => (
              <div key={g.label ?? gi}>
                {g.label && (
                  <p className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-[0.15em] text-ink-faint">
                    {g.label}
                  </p>
                )}
                {g.options.map((o) => {
                  idx += 1;
                  const i = idx;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      data-idx={i}
                      onMouseEnter={() => setHi(i)}
                      onClick={() => pick(o.value)}
                      className={`w-full text-left px-3 py-1 text-sm flex items-center justify-between gap-2 ${
                        i === hi ? "bg-ledger-soft" : ""
                      } ${o.value === value ? "text-ledger" : ""}`}
                    >
                      <span className="truncate">
                        {o.hint && <span className="text-ink-faint">{o.hint}</span>}
                        {o.label}
                      </span>
                      {o.value === value && <Check size={12} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && (
              <p className="px-3 py-2 text-xs text-ink-faint">No match.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

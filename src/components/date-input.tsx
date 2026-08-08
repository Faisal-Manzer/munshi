"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toISODate } from "@munshi/core";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

function fmtTrigger(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Ledger-styled date picker — trigger reads "06 Aug", panel is a small calendar. */
export function DateInput({
  value, onChange, className = "", chrome = false, autoOpen = false,
}: {
  value: string; // yyyy-mm-dd
  onChange: (iso: string) => void;
  className?: string;
  chrome?: boolean;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const d = new Date(value + "T00:00:00");
  const [view, setView] = useState({ y: d.getFullYear(), m: d.getMonth() });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const panelH = 264, panelW = 232;
    const up = r.bottom + panelH > window.innerHeight && r.top > panelH;
    setPos({
      top: up ? r.top - panelH - 2 : r.bottom + 2,
      left: Math.min(r.left, window.innerWidth - panelW - 8),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dd = new Date(value + "T00:00:00");
    setView({ y: dd.getFullYear(), m: dd.getMonth() });
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const first = new Date(view.y, view.m, 1);
  const startPad = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const todayISO = toISODate(new Date());
  const monthLabel = first.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  function pick(day: number) {
    setOpen(false);
    onChange(toISODate(new Date(view.y, view.m, day)));
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${chrome
          ? "border border-rule px-2 py-1.5 bg-paper-raised text-sm"
          : "px-2 py-1.5 hover:text-ledger"
        } amount text-left whitespace-nowrap w-full ${className}`}
      >
        {fmtTrigger(value)}
      </button>
      {open && (
        <div
          ref={panelRef}
          className="fixed z-[60] w-[232px] border border-rule-strong bg-paper-raised shadow-xl p-2"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="flex items-center justify-between mb-1">
            <button type="button" onClick={() => setView(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}
              className="p-1 text-ink-faint hover:text-ledger" aria-label="Previous month">
              <ChevronLeft size={14} />
            </button>
            <p className="text-xs font-medium">{monthLabel}</p>
            <button type="button" onClick={() => setView(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))}
              className="p-1 text-ink-faint hover:text-ledger" aria-label="Next month">
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="grid grid-cols-7 text-center">
            {WEEKDAYS.map((w, i) => (
              <span key={i} className="text-[10px] text-ink-faint py-0.5">{w}</span>
            ))}
            {Array.from({ length: startPad }).map((_, i) => <span key={"p" + i} />)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const iso = toISODate(new Date(view.y, view.m, day));
              const sel = iso === value;
              const isToday = iso === todayISO;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => pick(day)}
                  className={`amount text-xs py-1 ${sel
                    ? "bg-ledger text-paper-raised"
                    : isToday
                      ? "outline outline-1 outline-ledger text-ledger hover:bg-ledger-soft"
                      : "hover:bg-ledger-soft"}`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

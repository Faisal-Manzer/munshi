"use client";

import { ArrowDownLeft } from "lucide-react";
import { formatPaise } from "@/lib/money";

/** Small uppercase label over a tabular amount — the headline-number style
 * shared by Book and Plan so the two screens read as one product. */
export function Headline({
  label, paise, cls = "", incoming = false,
}: {
  label: string;
  paise: number;
  cls?: string;
  incoming?: boolean;
}) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</p>
      <p className={`amount inline-flex items-center gap-0.5 ${cls}`}>
        {incoming && <ArrowDownLeft size={11} className="text-ledger" />}
        {formatPaise(paise)}
      </p>
    </div>
  );
}

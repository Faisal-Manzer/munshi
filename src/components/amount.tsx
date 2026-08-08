import { formatPaise } from "@munshi/core";

export function Amount({
  paise,
  signed = false,
  className = "",
}: {
  paise: number;
  signed?: boolean;
  className?: string;
}) {
  const negative = paise < 0;
  const color = signed ? (negative ? "text-debit" : "text-ledger") : "";
  return (
    <span className={`amount ${color} ${className}`}>
      {signed && paise > 0 ? "+" : ""}
      {formatPaise(paise)}
    </span>
  );
}

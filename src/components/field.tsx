/**
 * Labeled form field — the label stays visible after the value is filled,
 * so an edit form never shows bare "3" / "19" inputs.
 */
export function Field({
  label, hint, className = "", children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-ink-soft mb-1">{label}</p>
      {children}
      {hint && <p className="text-[11px] text-ink-faint mt-1">{hint}</p>}
    </div>
  );
}

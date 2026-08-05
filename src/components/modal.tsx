"use client";

import { useEffect, useRef, useState } from "react";

export function Modal({
  open, title, subtitle, onClose, children, wide,
}: {
  open: boolean;
  title: string;
  /** Context line under the title — what kind of thing is being edited. */
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(28,36,32,0.35)" }} onMouseDown={onClose}>
      <div className={`w-full ${wide ? "max-w-xl" : "max-w-sm"} border border-rule-strong bg-paper-raised shadow-xl max-h-[90vh] overflow-y-auto`}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="px-4 pt-3 pb-2 border-b border-rule">
          <p className="text-sm font-medium">{title}</p>
          {subtitle && <p className="text-xs text-ink-faint">{subtitle}</p>}
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function InputModal({
  open, title, label, defaultValue = "", placeholder, submitLabel = "Save", onSubmit, onClose,
}: {
  open: boolean;
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setTimeout(() => ref.current?.select(), 30);
    }
  }, [open, defaultValue]);

  async function submit() {
    await onSubmit(value);
    onClose();
  }

  return (
    <Modal open={open} title={title} onClose={onClose}>
      {label && <p className="text-xs text-ink-soft mb-2">{label}</p>}
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised amount"
      />
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="text-sm text-ink-soft px-3 py-1.5 hover:text-ink">
          Cancel
        </button>
        <button onClick={submit}
          className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90">
          {submitLabel}
        </button>
      </div>
    </Modal>
  );
}

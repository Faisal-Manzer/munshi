"use client";

import type { Account, AccountSubtype } from "@/lib/types";

const GROUPS: { label: string; subtypes: AccountSubtype[] }[] = [
  { label: "Banks", subtypes: ["bank"] },
  { label: "Set aside", subtypes: ["envelope"] },
  { label: "Cash", subtypes: ["cash"] },
  { label: "Cards", subtypes: ["credit_card"] },
  { label: "Categories", subtypes: ["general_expense"] },
  { label: "People", subtypes: ["receivable"] },
  { label: "Loans", subtypes: ["loan"] },
  { label: "Income", subtypes: ["salary", "other_income"] },
  { label: "Investments", subtypes: ["investment"] },
];

export const NEW_CATEGORY = "__new_category__";

export function AccountSelect({
  value, onChange, choices, placeholder = "—", allowCreate = false, className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  choices: Account[];
  placeholder?: string;
  allowCreate?: boolean;
  className?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{placeholder}</option>
      {GROUPS.map((g) => {
        const items = choices.filter((a) => g.subtypes.includes(a.subtype));
        if (items.length === 0) return null;
        return (
          <optgroup key={g.label} label={g.label}>
            {items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.parent_id ? "· " : ""}{a.name}
              </option>
            ))}
          </optgroup>
        );
      })}
      {allowCreate && (
        <optgroup label="─────">
          <option value={NEW_CATEGORY}>＋ New category…</option>
        </optgroup>
      )}
    </select>
  );
}

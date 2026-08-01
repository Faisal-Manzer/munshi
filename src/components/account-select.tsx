"use client";

import { Select, type SelectGroup } from "@/components/select";
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

export function accountGroups(choices: Account[]): SelectGroup[] {
  return GROUPS.map((g) => ({
    label: g.label,
    options: choices
      .filter((a) => g.subtypes.includes(a.subtype))
      .map((a) => ({ value: a.id, label: a.name, hint: a.parent_id ? "· " : undefined })),
  })).filter((g) => g.options.length > 0);
}

export function AccountSelect({
  value, onChange, choices, placeholder = "—", allowCreate = false, className = "", chrome = false,
}: {
  value: string;
  onChange: (v: string) => void;
  choices: Account[];
  placeholder?: string;
  allowCreate?: boolean;
  className?: string;
  chrome?: boolean;
}) {
  const groups = accountGroups(choices);
  if (allowCreate) {
    groups.push({ options: [{ value: NEW_CATEGORY, label: "＋ New category…" }] });
  }
  return (
    <Select value={value} onChange={onChange} groups={groups}
      placeholder={placeholder} className={className} chrome={chrome} />
  );
}

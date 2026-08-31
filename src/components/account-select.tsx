"use client";

import { Select, type SelectGroup } from "@/components/select";
import type { Account, AccountSubtype } from "@munshi/core";

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
export const NEW_INCOME = "__new_income__";

/** Which "＋ New …" row a select offers, if any. */
export type CreateOption = "expense" | "income";

const CREATE_ROW: Record<CreateOption, { value: string; label: string }> = {
  expense: { value: NEW_CATEGORY, label: "＋ New category…" },
  income: { value: NEW_INCOME, label: "＋ New income source…" },
};

export function accountGroups(choices: Account[]): SelectGroup[] {
  return GROUPS.map((g) => ({
    label: g.label,
    options: choices
      .filter((a) => g.subtypes.includes(a.subtype))
      .map((a) => ({ value: a.id, label: a.name, hint: a.parent_id ? "· " : undefined })),
  })).filter((g) => g.options.length > 0);
}

export function AccountSelect({
  value, onChange, choices, placeholder = "—", allowCreate, className = "", chrome = false,
}: {
  value: string;
  onChange: (v: string) => void;
  choices: Account[];
  placeholder?: string;
  /** Offer an inline create row for this kind of account. */
  allowCreate?: CreateOption;
  className?: string;
  chrome?: boolean;
}) {
  const groups = accountGroups(choices);
  if (allowCreate) {
    groups.push({ options: [CREATE_ROW[allowCreate]] });
  }
  return (
    <Select value={value} onChange={onChange} groups={groups}
      placeholder={placeholder} className={className} chrome={chrome} />
  );
}

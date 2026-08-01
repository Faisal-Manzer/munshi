"use client";

import { Modal } from "@/components/modal";
import { Amount } from "@/components/amount";
import type { Account, AccountBalance } from "@/lib/types";
import { Pencil, Plus } from "lucide-react";

/** Manage expense categories & income sources — rare CRUD tucked behind the sidebar gear. */
export function CategoriesModal({
  open, accounts, balances, onEdit, onNew, onClose,
}: {
  open: boolean;
  accounts: Account[];
  balances: Map<string, AccountBalance>;
  onEdit: (a: Account) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const active = accounts.filter((a) => !a.archived);
  const groups: [string, Account[]][] = [
    ["Income sources", active.filter((a) => a.kind === "income")],
    ["Expense categories", active.filter((a) => a.kind === "expense")],
  ];
  return (
    <Modal open={open} title="Categories & income" onClose={onClose}>
      <div className="space-y-4">
        {groups.map(([title, list]) => (
          <div key={title}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-ink-faint mb-1">{title}</p>
            <div className="divide-y divide-rule/60">
              {list.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 py-1">
                  <p className="text-sm">{a.name}</p>
                  <div className="flex items-center gap-1.5">
                    <Amount paise={balances.get(a.id)?.balance_paise ?? 0} className="text-ink-faint" />
                    <button onClick={() => onEdit(a)} title={`Edit ${a.name}`}
                      className="text-ink-faint hover:text-ledger p-0.5">
                      <Pencil size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {list.length === 0 && <p className="text-xs text-ink-faint py-1">None yet.</p>}
            </div>
          </div>
        ))}
        <button onClick={onNew}
          className="flex items-center gap-1 text-xs border border-ledger text-ledger px-2 py-1 hover:bg-ledger-soft">
          <Plus size={12} /> New category / income source
        </button>
      </div>
    </Modal>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useLedger } from "@/lib/use-ledger";
import { Modal } from "@/components/modal";
import { Amount } from "@/components/amount";
import { formatPaise } from "@/lib/money";
import type { Account, Posting, Transaction } from "@/lib/types";

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
}

/** Full posting history for one person (receivable account). */
export function PersonModal({
  person, balancePaise, onClose,
}: {
  person: Account | null;
  balancePaise: number;
  onClose: () => void;
}) {
  const { supabase } = useLedger();
  const [rows, setRows] = useState<(Posting & { transactions: Transaction })[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!person) return;
    setRows([]);
    supabase
      .from("postings")
      .select("*, transactions(*)")
      .eq("account_id", person.id)
      .then(({ data, error: e }) => {
        if (e) {
          setError(e.message);
          return;
        }
        const list = (data ?? []) as (Posting & { transactions: Transaction })[];
        list.sort((a, b) => (a.transactions.date < b.transactions.date ? 1 : -1));
        setRows(list);
      });
  }, [supabase, person]);

  return (
    <Modal open={person !== null} wide title={person?.name ?? ""} onClose={onClose}>
      <p className="text-xs text-ink-soft mb-3">
        {balancePaise > 0
          ? `Owes you ${formatPaise(balancePaise)}`
          : balancePaise < 0
            ? `You owe ${formatPaise(-balancePaise)}`
            : "All settled"}
        {" · "}positive = they owe more, negative = they paid back
      </p>
      {error && <p className="text-sm text-debit mb-2">{error}</p>}
      <table className="w-full text-sm ledger-grid">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.transactions.status === "pending" ? "bg-pending-soft/40" : ""}>
              <td className="py-1.5 pr-3 w-24 amount text-ink-faint whitespace-nowrap">
                {fmtDate(r.transactions.date)}
              </td>
              <td className="py-1.5 pr-3">
                {r.transactions.description}
                {r.transactions.status === "pending" && (
                  <span className="text-pending text-xs"> · pending</span>
                )}
              </td>
              <td className="py-1.5 text-right">
                <Amount paise={r.amount_paise} signed />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !error && (
        <p className="text-sm text-ink-faint">No entries yet.</p>
      )}
    </Modal>
  );
}

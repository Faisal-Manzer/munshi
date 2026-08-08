"use client";

/**
 * Switching the active book to encrypted storage. Deliberately explicit: it
 * rewrites every row under a key only this browser holds, and once done the
 * data is unreadable without the passphrase or the recovery kit. So the
 * confirmation states that in those words rather than "are you sure?".
 */
import { useCallback, useEffect, useState } from "react";
import { useLedger } from "@/lib/use-ledger";
import {
  encryptBook,
  encryptionStatus,
  type EncryptProgress,
} from "@/lib/e2ee/encrypt-book";

export function EncryptBookRow() {
  const { supabase, ledgerId, ledger, ledgerKey, provisionLedgerKey, reload, reloadKey } =
    useLedger();
  const [status, setStatus] = useState<{ plaintextRows: number; encryptedAt: string | null } | null>(
    null
  );
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<EncryptProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ledgerId) return;
    try {
      setStatus(await encryptionStatus(supabase, ledgerId));
    } catch {
      setStatus(null);
    }
  }, [supabase, ledgerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run() {
    if (!ledgerId) return;
    setErr(null);
    setProgress({ step: "keys", done: 0, total: 1 });
    try {
      const key = ledgerKey ?? (await provisionLedgerKey());
      await encryptBook(supabase, ledgerId, key, setProgress);
      await reloadKey();
      await refresh();
      await reload();
      setConfirming(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setProgress(null);
    }
  }

  const encrypted = !!status?.encryptedAt && status.plaintextRows === 0;
  const partial = !!status && status.plaintextRows > 0 && !!status.encryptedAt;

  return (
    <div className="border-b border-rule py-1.5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm">This book{ledger?.name ? ` — ${ledger.name}` : ""}</p>
          <p className="text-[11px] text-ink-faint">
            {encrypted
              ? `Encrypted ${new Date(status!.encryptedAt!).toLocaleDateString("en-IN", {
                  day: "2-digit", month: "short", year: "numeric",
                })}`
              : partial
                ? `${status!.plaintextRows} rows still readable by the server`
                : status
                  ? `${status.plaintextRows} rows readable by the server`
                  : "—"}
          </p>
        </div>
        {!encrypted && !progress && (
          <button onClick={() => setConfirming((v) => !v)}
            className="text-xs text-ledger hover:underline">
            {partial ? "Finish encrypting" : "Encrypt"}
          </button>
        )}
        {progress && (
          <span className="text-[11px] text-ink-faint amount">
            {progress.done}/{progress.total}
          </span>
        )}
      </div>

      {confirming && !progress && (
        <div className="border border-rule bg-paper px-3 py-2 space-y-2">
          <p className="text-xs text-ink-soft">
            Every amount, name and note in this book gets rewritten as ciphertext
            under a key held only by you. After this, losing both your passphrase
            and your recovery kit means the book is gone — we cannot restore it.
          </p>
          <p className="text-[11px] text-ink-faint">
            Dates, account structure and statement days stay readable to the server.
          </p>
          <div className="flex gap-2">
            <button onClick={run}
              className="text-xs bg-ledger text-paper-raised px-3 py-1 hover:opacity-90">
              Encrypt this book
            </button>
            <button onClick={() => setConfirming(false)}
              className="text-xs text-ink-soft px-2 py-1 hover:text-ink">
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <p className="text-xs text-debit">{err}</p>}
    </div>
  );
}

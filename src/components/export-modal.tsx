"use client";

/**
 * Getting your book out.
 *
 * Runs entirely here, in the tab that holds the key: it re-reads the ledger
 * through the same loader the screens use, decrypts it, and builds the files
 * in memory. Nothing is uploaded, no server ever sees plaintext — which is
 * the whole point, because on an encrypted book nobody else *can* produce
 * this file (docs/E2EE.md §8).
 */
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { loadLedger } from "@munshi/store";
import { exportCsvs, exportFileName, exportJson, type ExportFile } from "@munshi/core";
import { useActiveLedger } from "@/lib/ledger-context";
import { useLedgerKey } from "@/lib/e2ee/use-ledger-key";
import { Modal } from "@/components/modal";
import { Download, FileJson, Sheet } from "lucide-react";

function download(file: ExportFile) {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke late: Safari cancels the download if the URL dies too early
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExportModal({ onClose }: { onClose: () => void }) {
  const { ledger, ledgerId } = useActiveLedger();
  const { key: ledgerKey, ready } = useLedgerKey(ledgerId);
  const [busy, setBusy] = useState<"json" | "csv" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function build() {
    if (!ledgerId) throw new Error("No ledger open.");
    if (!ready) throw new Error("Still opening the book — try again in a moment.");
    const snap = await loadLedger(createClient(), ledgerId, ledgerKey);
    return {
      ledger: ledger ? { id: ledger.id, name: ledger.name } : null,
      ...snap,
    };
  }

  async function run(what: "json" | "csv") {
    setBusy(what);
    setError(null);
    setDone(null);
    try {
      const input = await build();
      const at = new Date();
      if (what === "json") {
        const file = exportJson(input, at);
        download(file);
        setDone(file.name);
      } else {
        const files = exportCsvs(input);
        for (const f of files) {
          download({ ...f, name: exportFileName(ledger?.name, f.name, at) });
        }
        setDone(`${files.length} files`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "export failed");
    }
    setBusy(null);
  }

  const row = "w-full flex items-start gap-3 border border-rule px-3 py-2.5 text-left hover:border-ledger/60 hover:bg-ledger-soft/30 disabled:opacity-60";

  return (
    <Modal open title={`Export “${ledger?.name ?? ""}”`}
      subtitle="Built in this tab, from your decrypted book — nothing is uploaded"
      onClose={onClose}>
      <div className="space-y-3">
        <button onClick={() => run("json")} disabled={busy !== null} className={row}>
          <FileJson size={15} className="text-ledger mt-0.5 shrink-0" />
          <span>
            <span className="block text-sm">
              {busy === "json" ? "Building…" : "JSON — the whole book"}
            </span>
            <span className="block text-xs text-ink-faint">
              Accounts, entries, postings and recurring templates, ids and paise
              intact. The archive copy — lossless, and the one to keep.
            </span>
          </span>
        </button>

        <button onClick={() => run("csv")} disabled={busy !== null} className={row}>
          <Sheet size={15} className="text-ledger mt-0.5 shrink-0" />
          <span>
            <span className="block text-sm">
              {busy === "csv" ? "Building…" : "CSV — four spreadsheets"}
            </span>
            <span className="block text-xs text-ink-faint">
              entries, accounts, postings, recurring. Names instead of ids,
              rupees instead of paise — readable, but lossy.
            </span>
          </span>
        </button>

        {error && <p className="text-sm text-debit">{error}</p>}
        {done && (
          <p className="text-xs text-ledger flex items-center gap-1.5">
            <Download size={12} /> Downloaded {done}.
          </p>
        )}
        <p className="text-[11px] text-ink-faint">
          Your browser may ask permission to save several files at once — the
          CSV option downloads four.
        </p>
      </div>
    </Modal>
  );
}

"use client";

/**
 * Opening an existing vault. Two ways in: the passphrase, or the 24 words when
 * the passphrase is gone. There is deliberately no third way, and no "reset" —
 * a reset link would mean we could read the books.
 */
import { useState } from "react";
import { Modal } from "@/components/modal";
import { Field } from "@/components/field";
import { useVault } from "@/lib/e2ee/vault-context";
import { isCompleteMnemonic } from "@munshi/crypto";

export function VaultUnlockModal({ onClose }: { onClose: () => void }) {
  const { unlock, unlockWithWords } = useVault();
  const [mode, setMode] = useState<"passphrase" | "recovery">("passphrase");
  const [pass, setPass] = useState("");
  const [words, setWords] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "passphrase") {
        await unlock(pass, remember);
      } else {
        await unlockWithWords(words);
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  const ready = mode === "passphrase" ? pass.length > 0 : isCompleteMnemonic(words);

  return (
    <Modal open
      title={mode === "passphrase" ? "Unlock your books" : "Recover with your kit"}
      subtitle={mode === "passphrase"
        ? "Your encryption passphrase — not your login"
        : "The 24 words from your recovery kit"}
      onClose={onClose}>
      <div className="space-y-3">
        {mode === "passphrase" ? (
          <>
            <Field label="Encryption passphrase">
              <input type="password" value={pass} autoFocus
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ready && submit()}
                className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised" />
            </Field>
            <label className="flex items-center gap-2 text-xs text-ink-soft">
              <input type="checkbox" checked={remember}
                onChange={(e) => setRemember(e.target.checked)} />
              Stay unlocked on this browser
            </label>
          </>
        ) : (
          <Field label="Recovery words"
            hint="All 24, in order. Case and punctuation do not matter.">
            <textarea value={words} autoFocus rows={4}
              onChange={(e) => setWords(e.target.value)}
              className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised" />
          </Field>
        )}
        {err && <p className="text-sm text-debit">{err}</p>}
        <div className="flex items-center justify-between pt-1">
          <button
            onClick={() => {
              setMode(mode === "passphrase" ? "recovery" : "passphrase");
              setErr(null);
            }}
            className="text-xs text-ink-faint hover:text-ledger underline decoration-dotted">
            {mode === "passphrase" ? "Forgot it? Use recovery kit" : "Use passphrase instead"}
          </button>
          <button onClick={submit} disabled={!ready || busy}
            className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90 disabled:opacity-40">
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

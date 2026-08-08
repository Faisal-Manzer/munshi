"use client";

/**
 * What you can do once the vault is open: change the passphrase, re-read the
 * recovery kit, lock, and forget this browser. Plus the honest boundary —
 * what the server can still see — stated here rather than only in a doc.
 */
import { useState } from "react";
import { Modal } from "@/components/modal";
import { Field } from "@/components/field";
import { useVault } from "@/lib/e2ee/vault-context";
import { RecoveryActions, RecoveryWords } from "@/components/vault/recovery-kit";
import { EncryptBookRow } from "@/components/vault/encrypt-book-row";

export function VaultSettingsModal({ email, onClose }: { email: string; onClose: () => void }) {
  const {
    record, deviceRemembered, lock, changePassphrase, showRecoveryWords, setDeviceRemembered,
  } = useVault();
  const [view, setView] = useState<"home" | "passphrase" | "kit">("home");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [mnemonic, setMnemonic] = useState("");

  async function submitPassphrase() {
    if (next.length < 10 || next !== again) return;
    setBusy(true);
    setErr(null);
    try {
      await changePassphrase(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setAgain("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  function reveal() {
    try {
      setMnemonic(showRecoveryWords());
      setView("kit");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <Modal open wide title="Encryption" subtitle={email} onClose={onClose}>
      {view === "home" && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Row label="Passphrase" action="Change" onClick={() => { setView("passphrase"); setDone(false); }} />
            <Row label="Recovery kit"
              hint={record?.recoveryConfirmedAt ? "Saved" : "Never confirmed saved"}
              action="Show words" onClick={reveal} />
            <EncryptBookRow />
            <Row label="This browser"
              hint={deviceRemembered ? "Stays unlocked here" : "Asks every visit"}
              action={deviceRemembered ? "Forget" : "Remember"}
              onClick={() => setDeviceRemembered(!deviceRemembered)} />
          </div>
          {err && <p className="text-sm text-debit">{err}</p>}

          <div className="border border-rule bg-paper px-3 py-2 space-y-1">
            <p className="text-xs text-ink-soft">
              Your keys are derived from your passphrase on this device and never sent
              to the server.
            </p>
            <p className="text-[11px] text-ink-faint">
              The server still sees: your email, which books exist and who is in
              them, and when rows change. It cannot see amounts, names, or notes
              once your ledger data moves behind these keys.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => { lock(); onClose(); }}
              className="text-sm border border-rule px-3 py-1.5 text-ink-soft hover:text-ink">
              Lock now
            </button>
            <button onClick={onClose}
              className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90">
              Done
            </button>
          </div>
        </div>
      )}

      {view === "passphrase" && (
        <div className="space-y-3">
          <p className="text-xs text-ink-soft">
            Changing this re-wraps your key — your books are never re-encrypted,
            and your recovery kit keeps working.
          </p>
          <Field label="Current passphrase">
            <input type="password" value={current} autoFocus
              onChange={(e) => setCurrent(e.target.value)}
              className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised" />
          </Field>
          <Field label="New passphrase" hint="At least 10 characters.">
            <input type="password" value={next}
              onChange={(e) => setNext(e.target.value)}
              className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised" />
          </Field>
          <Field label="Type it again">
            <input type="password" value={again}
              onChange={(e) => setAgain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitPassphrase()}
              className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised" />
          </Field>
          {next.length > 0 && next.length < 10 && (
            <p className="text-xs text-debit">Too short — 10 characters minimum.</p>
          )}
          {again.length > 0 && next !== again && (
            <p className="text-xs text-debit">These do not match.</p>
          )}
          {err && <p className="text-sm text-debit">{err}</p>}
          {done && <p className="text-xs text-ledger">Passphrase changed.</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setView("home")}
              className="text-sm text-ink-soft px-3 py-1.5 hover:text-ink">Back</button>
            <button onClick={submitPassphrase}
              disabled={busy || next.length < 10 || next !== again || !current}
              className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90 disabled:opacity-40">
              {busy ? "Rewrapping…" : "Change passphrase"}
            </button>
          </div>
        </div>
      )}

      {view === "kit" && (
        <div className="space-y-3">
          <p className="text-xs text-ink-soft">
            The same 24 words as at setup. Anyone holding them can read your books.
          </p>
          <RecoveryWords mnemonic={mnemonic} />
          <RecoveryActions mnemonic={mnemonic} email={email} />
          <div className="flex justify-end">
            <button onClick={() => { setMnemonic(""); setView("home"); }}
              className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90">
              Hide
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({
  label, hint, action, onClick,
}: {
  label: string;
  hint?: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-rule py-1.5">
      <div>
        <p className="text-sm">{label}</p>
        {hint && <p className="text-[11px] text-ink-faint">{hint}</p>}
      </div>
      <button onClick={onClick} className="text-xs text-ledger hover:underline">
        {action}
      </button>
    </div>
  );
}

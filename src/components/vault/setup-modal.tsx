"use client";

/**
 * Turning on encryption. Three steps, in this order for a reason: the
 * passphrase is chosen, the recovery kit is shown, and only a proof that the
 * kit was written down finishes the flow. The kit cannot be skipped — a
 * passphrase people invent today is the passphrase they forget in March.
 */
import { useState } from "react";
import { Modal } from "@/components/modal";
import { Field } from "@/components/field";
import { useVault } from "@/lib/e2ee/vault-context";
import { ConfirmWords, RecoveryActions, RecoveryWords } from "@/components/vault/recovery-kit";

type Step = "passphrase" | "kit" | "confirm";

const MIN_LENGTH = 10;

export function VaultSetupModal({ email, onClose }: { email: string; onClose: () => void }) {
  const { setUp, confirmRecoverySaved } = useVault();
  const [step, setStep] = useState<Step>("passphrase");
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState("");

  const tooShort = pass.length > 0 && pass.length < MIN_LENGTH;
  const mismatch = again.length > 0 && pass !== again;
  const canSubmit = pass.length >= MIN_LENGTH && pass === again && !busy;

  async function create() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      setMnemonic(await setUp(pass));
      setPass("");
      setAgain("");
      setStep("kit");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    try {
      await confirmRecoverySaved();
    } catch {
      // the flag is a convenience; failing to record it must not trap the user
    }
    onClose();
  }

  return (
    <Modal open wide
      title={step === "passphrase" ? "Set an encryption passphrase" : "Your recovery kit"}
      subtitle={step === "passphrase"
        ? "Separate from your login — it never leaves this device"
        : "24 words that can open your books if the passphrase is ever lost"}
      // closing mid-kit would strand a vault whose recovery kit was never seen
      onClose={step === "passphrase" ? onClose : () => {}}>
      {step === "passphrase" && (
        <div className="space-y-3">
          <p className="text-xs text-ink-soft">
            This passphrase encrypts your books. We never receive it, so we can
            never reset it for you — that is the point, and the risk.
          </p>
          <Field label="Encryption passphrase"
            hint={`At least ${MIN_LENGTH} characters. A phrase you can recall beats a short jumble.`}>
            <input type="password" value={pass} autoFocus
              onChange={(e) => setPass(e.target.value)}
              className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised" />
          </Field>
          {tooShort && <p className="text-xs text-debit">Too short — {MIN_LENGTH} characters minimum.</p>}
          <Field label="Type it again">
            <input type="password" value={again}
              onChange={(e) => setAgain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised" />
          </Field>
          {mismatch && <p className="text-xs text-debit">These do not match.</p>}
          {err && <p className="text-sm text-debit">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="text-sm text-ink-soft px-3 py-1.5 hover:text-ink">
              Not now
            </button>
            <button onClick={create} disabled={!canSubmit}
              className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90 disabled:opacity-40">
              {busy ? "Generating keys…" : "Continue"}
            </button>
          </div>
        </div>
      )}

      {step === "kit" && (
        <div className="space-y-3">
          <p className="text-xs text-ink-soft">
            Write these down or print them. Anyone holding them can read your
            books; without them, a forgotten passphrase means the data is gone
            for good.
          </p>
          <RecoveryWords mnemonic={mnemonic} />
          <RecoveryActions mnemonic={mnemonic} email={email} />
          <div className="flex justify-end pt-1">
            <button onClick={() => setStep("confirm")}
              className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90">
              I have saved them
            </button>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <div className="space-y-3">
          <ConfirmWords mnemonic={mnemonic} onConfirmed={finish} />
          <button onClick={() => setStep("kit")}
            className="text-xs text-ink-faint hover:text-ledger underline decoration-dotted">
            Show the words again
          </button>
        </div>
      )}
    </Modal>
  );
}

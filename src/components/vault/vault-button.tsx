"use client";

/**
 * The vault's one control in the header. It shows state before it offers
 * action: not set up, locked, or open — so "is my data encrypted?" is
 * answerable at a glance rather than buried in settings.
 *
 * Nothing is encrypted yet (phase 3 moves the data), so this never blocks the
 * ledger. The button says so plainly instead of implying protection that is
 * not there yet.
 */
import { useState } from "react";
import { Lock, LockOpen, ShieldOff } from "lucide-react";
import { useVault } from "@/lib/e2ee/vault-context";
import { VaultSetupModal } from "@/components/vault/setup-modal";
import { VaultUnlockModal } from "@/components/vault/unlock-modal";
import { VaultSettingsModal } from "@/components/vault/settings-modal";

export function VaultButton({ email }: { email: string }) {
  const { status } = useVault();
  const [open, setOpen] = useState<"setup" | "unlock" | "settings" | null>(null);

  if (status === "loading") return null;

  const face = {
    absent: {
      icon: <ShieldOff size={15} />,
      cls: "text-ink-faint hover:text-ink",
      title: "Encryption is off — set an encryption passphrase",
      go: "setup" as const,
    },
    locked: {
      icon: <Lock size={15} />,
      cls: "text-debit hover:opacity-80",
      title: "Keys are locked — unlock to use them",
      go: "unlock" as const,
    },
    unlocked: {
      icon: <LockOpen size={15} />,
      cls: "text-ledger hover:opacity-80",
      title: "Keys are open on this device",
      go: "settings" as const,
    },
  }[status];

  return (
    <>
      <button onClick={() => setOpen(face.go)} title={face.title} aria-label={face.title}
        className={face.cls}>
        {face.icon}
      </button>
      {open === "setup" && <VaultSetupModal email={email} onClose={() => setOpen(null)} />}
      {open === "unlock" && <VaultUnlockModal onClose={() => setOpen(null)} />}
      {open === "settings" && <VaultSettingsModal email={email} onClose={() => setOpen(null)} />}
    </>
  );
}

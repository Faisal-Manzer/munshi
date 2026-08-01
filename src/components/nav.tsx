"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/modal";
import { X } from "lucide-react";

const LINKS = [
  { href: "/", label: "Book" },
  { href: "/plan", label: "Plan" },
];

export function Nav({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [membersOpen, setMembersOpen] = useState(false);

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-rule-strong bg-paper-raised">
      <div className="max-w-[1800px] mx-auto px-4 sm:px-8 flex items-center gap-6 h-14">
        <Link href="/" className="font-display text-xl leading-none" style={{ fontFamily: "var(--font-instrument-serif)" }}>
          Munshi
        </Link>
        <nav className="flex items-center gap-1 overflow-x-auto">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`px-3 py-1.5 text-sm whitespace-nowrap border-b-2 ${
                  active
                    ? "border-ledger text-ledger font-medium"
                    : "border-transparent text-ink-soft hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setMembersOpen(true)}
            className="hidden sm:block text-xs text-ink-faint hover:text-ledger"
            title="Ledger members — emails that share this ledger"
          >
            {email}
          </button>
          <button
            onClick={signOut}
            className="text-xs text-ink-soft hover:text-debit"
          >
            Sign out
          </button>
        </div>
      </div>
      {membersOpen && <MembersModal email={email} onClose={() => setMembersOpen(false)} />}
    </header>
  );
}

function MembersModal({ email, onClose }: { email: string; onClose: () => void }) {
  const [supabase] = useState(() => createClient());
  const [members, setMembers] = useState<string[] | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data, error: e } = await supabase.rpc("ledger_members_list");
    if (e) setError(e.message);
    else setMembers((data ?? []) as string[]);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add() {
    const v = newEmail.trim().toLowerCase();
    if (!v) return;
    const { error: e } = await supabase.rpc("ledger_member_add", { new_email: v });
    if (e) {
      setError(e.message);
      return;
    }
    setError(null);
    setNewEmail("");
    await load();
  }

  async function remove(m: string) {
    if (!confirm(`Remove ${m}? They lose access to this ledger immediately.`)) return;
    const { error: e } = await supabase.rpc("ledger_member_remove", { old_email: m });
    if (e) {
      setError(e.message);
      return;
    }
    setError(null);
    await load();
  }

  return (
    <Modal open title="Ledger members" onClose={onClose}>
      <p className="text-xs text-ink-soft mb-3">
        Every email here signs in with Google and sees this exact ledger.
      </p>
      {members === null && !error && <p className="text-sm text-ink-faint">Loading…</p>}
      {members !== null && members.length === 0 && (
        <p className="text-sm text-ink-faint mb-3">
          Your ledger is private — sharing is set up per ledger; ask the owner
          to add your email.
        </p>
      )}
      {members !== null && members.length > 0 && (
        <div className="divide-y divide-rule/60 mb-3">
          {members.map((m) => (
            <div key={m} className="flex items-center justify-between gap-2 py-1.5">
              <p className="text-sm">
                {m}
                {m === email.toLowerCase() && <span className="text-xs text-ink-faint"> · you</span>}
              </p>
              {m !== email.toLowerCase() && (
                <button onClick={() => remove(m)} title={`Remove ${m}`}
                  className="text-ink-faint hover:text-debit p-0.5">
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-debit mb-2">{error}</p>}
      {members !== null && members.length > 0 && (
        <div className="flex gap-2">
          <input
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="another@gmail.com"
            className="flex-1 border border-rule px-3 py-2 text-sm bg-paper-raised"
          />
          <button onClick={add}
            className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90">
            Add
          </button>
        </div>
      )}
    </Modal>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useActiveLedger } from "@/lib/ledger-context";
import { Modal } from "@/components/modal";
import { Field } from "@/components/field";
import { BookOpen, Check, ChevronDown, Eye, EyeOff, Plus, Users, X } from "lucide-react";
import type { LedgerMember, LedgerRole } from "@/lib/types";

const LINKS = [
  { href: "/", label: "Book" },
  { href: "/plan", label: "Plan" },
];

export function Nav({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [privacy, setPrivacy] = useState(false);

  useEffect(() => {
    const on = localStorage.getItem("munshi-privacy") !== "0"; // blurred by default
    setPrivacy(on);
    document.documentElement.classList.toggle("privacy", on);
  }, []);

  function togglePrivacy() {
    const on = !privacy;
    setPrivacy(on);
    document.documentElement.classList.toggle("privacy", on);
    localStorage.setItem("munshi-privacy", on ? "1" : "0");
  }

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
        <LedgerSwitcher email={email} />
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
            onClick={togglePrivacy}
            title={privacy ? "Show amounts" : "Privacy — blur amounts (hover reveals one)"}
            aria-label={privacy ? "Show amounts" : "Blur amounts"}
            className={privacy ? "text-ledger" : "text-ink-faint hover:text-ink"}
          >
            {privacy ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <span className="hidden sm:block text-xs text-ink-faint" title="Signed in as">
            {email}
          </span>
          <button
            onClick={signOut}
            className="text-xs text-ink-soft hover:text-debit"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

/** Which book is on the desk — switch, share, create, rename. */
function LedgerSwitcher({ email }: { email: string }) {
  const { ledgers, ledger, ledgerId, switchLedger, createLedger, renameLedger } =
    useActiveLedger();
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  async function submitCreate() {
    if (!name.trim()) return;
    try {
      const id = await createLedger(name.trim());
      switchLedger(id);
      setCreating(false);
      setName("");
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }

  async function submitRename() {
    if (!name.trim() || !ledgerId) return;
    try {
      await renameLedger(ledgerId, name.trim());
      setRenaming(false);
      setName("");
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm border border-rule px-2.5 py-1 bg-paper hover:border-ledger/50"
        title="Switch ledger"
      >
        <BookOpen size={13} className="text-ink-faint" />
        <span className="max-w-[10rem] truncate">{ledger?.name ?? "…"}</span>
        <ChevronDown size={13} className="text-ink-faint" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-40 min-w-[14rem] border border-rule-strong bg-paper-raised shadow-lg py-1">
          {ledgers.map((l) => (
            <button
              key={l.id}
              onClick={() => {
                switchLedger(l.id);
                setOpen(false);
              }}
              className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-sm text-left hover:bg-ledger-soft/40"
            >
              <span className="truncate">{l.name}</span>
              {l.id === ledgerId && <Check size={13} className="text-ledger shrink-0" />}
            </button>
          ))}
          <div className="border-t border-rule mt-1 pt-1">
            <button
              onClick={() => {
                setOpen(false);
                setSharing(true);
              }}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-sm text-left text-ink-soft hover:bg-ledger-soft/40"
            >
              <Users size={13} /> Share this ledger\u2026
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setName(ledger?.name ?? "");
                setRenaming(true);
              }}
              className="w-full px-3 py-1.5 text-sm text-left text-ink-soft hover:bg-ledger-soft/40"
            >
              Rename this ledger…
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setName("");
                setCreating(true);
              }}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-sm text-left text-ledger hover:bg-ledger-soft/40"
            >
              <Plus size={13} /> New ledger
            </button>
          </div>
        </div>
      )}
      {sharing && <MembersModal email={email} onClose={() => setSharing(false)} />}
      {(creating || renaming) && (
        <Modal
          open
          title={creating ? "New ledger" : "Rename ledger"}
          subtitle={creating
            ? "A separate book — its own accounts, entries, and members"
            : undefined}
          onClose={() => {
            setCreating(false);
            setRenaming(false);
            setErr(null);
          }}
        >
          <div className="space-y-3">
            <Field label="Ledger name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (creating ? submitCreate() : submitRename())}
                autoFocus
                placeholder={creating ? "e.g. Company, House" : ""}
                className="w-full border border-rule px-3 py-2 text-sm bg-paper-raised"
              />
            </Field>
            {err && <p className="text-sm text-debit">{err}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setCreating(false);
                  setRenaming(false);
                }}
                className="text-sm text-ink-soft px-3 py-1.5 hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={creating ? submitCreate : submitRename}
                className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90"
              >
                {creating ? "Create" : "Rename"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const ROLE_HELP: Record<LedgerRole, string> = {
  owner: "Full control — entries, settings, and who has access",
  editor: "Can add and edit entries; can\u2019t manage people",
  viewer: "Can look at everything; can\u2019t change anything",
};

function RoleSelect({
  value, onChange, disabled,
}: {
  value: LedgerRole;
  onChange: (r: LedgerRole) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as LedgerRole)}
      title={ROLE_HELP[value]}
      className="text-xs text-ink-soft bg-transparent border border-transparent hover:border-rule px-1 py-0.5 disabled:opacity-100 disabled:appearance-none"
    >
      <option value="owner">owner</option>
      <option value="editor">editor</option>
      <option value="viewer">viewer</option>
    </select>
  );
}

function MembersModal({ email, onClose }: { email: string; onClose: () => void }) {
  const [supabase] = useState(() => createClient());
  const { ledger, ledgerId } = useActiveLedger();
  const [members, setMembers] = useState<LedgerMember[] | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<LedgerRole>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const me = email.toLowerCase();
  const isOwner = members?.some((m) => m.email === me && m.role === "owner") ?? false;

  async function load() {
    const { data, error: e } = await supabase.rpc("ledger_members_list", { l: ledgerId });
    if (e) setError(e.message);
    else setMembers((data ?? []) as LedgerMember[]);
  }

  useEffect(() => {
    if (ledgerId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerId]);

  async function setRole(target: string, role: LedgerRole) {
    setBusy(true);
    const { error: e } = await supabase.rpc("ledger_member_add", {
      l: ledgerId, new_email: target, new_role: role,
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setError(null);
    await load();
  }

  async function invite() {
    const v = newEmail.trim().toLowerCase();
    if (!v) return;
    if (members?.some((m) => m.email === v)) {
      setError(`${v} already has access.`);
      return;
    }
    setBusy(true);
    const { error: e } = await supabase.rpc("ledger_member_add", {
      l: ledgerId, new_email: v, new_role: newRole,
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setError(null);
    setNewEmail("");
    await load();
  }

  async function remove(m: string) {
    if (!confirm(`Remove ${m} from \u201c${ledger?.name}\u201d? They lose access immediately.`)) return;
    setBusy(true);
    const { error: e } = await supabase.rpc("ledger_member_remove", { l: ledgerId, old_email: m });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setError(null);
    await load();
  }

  return (
    <Modal open title={`Share \u201c${ledger?.name ?? ""}\u201d`}
      subtitle="Everyone below signs in with Google and opens this exact book"
      onClose={onClose}>
      <div className="space-y-4">
        {isOwner && (
          <div className="flex gap-2">
            <input
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
              placeholder="Add people by email\u2026"
              autoFocus
              className="flex-1 min-w-0 border border-rule px-3 py-2 text-sm bg-paper-raised"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as LedgerRole)}
              title={ROLE_HELP[newRole]}
              className="border border-rule px-2 py-2 text-sm bg-paper-raised"
            >
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
              <option value="owner">owner</option>
            </select>
            <button onClick={invite} disabled={busy || !newEmail.trim()}
              className="text-sm bg-ledger text-paper-raised px-4 py-1.5 hover:opacity-90 disabled:opacity-50">
              Invite
            </button>
          </div>
        )}
        {isOwner && <p className="text-[11px] text-ink-faint -mt-2">{ROLE_HELP[newRole]}</p>}

        {members === null && !error && <p className="text-sm text-ink-faint">Loading\u2026</p>}
        {members !== null && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">
              Who has access
            </p>
            <div className="divide-y divide-rule/60 border-y border-rule/60">
              {members.map((m) => {
                const self = m.email === me;
                return (
                  <div key={m.email} className="flex items-center gap-3 py-2">
                    <span className="w-7 h-7 shrink-0 rounded-full bg-ledger-soft text-ledger grid place-items-center text-xs font-medium uppercase">
                      {m.email[0]}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">
                        {m.email}
                        {self && <span className="text-xs text-ink-faint"> \u00b7 you</span>}
                      </p>
                      <p className="text-[11px] text-ink-faint">{ROLE_HELP[m.role]}</p>
                    </div>
                    {isOwner && !self ? (
                      <>
                        <RoleSelect value={m.role} disabled={busy}
                          onChange={(r) => setRole(m.email, r)} />
                        <button onClick={() => remove(m.email)} disabled={busy}
                          title={`Remove ${m.email}`}
                          className="text-ink-faint hover:text-debit p-0.5">
                          <X size={13} />
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-ink-soft">{m.role}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-debit">{error}</p>}
        {members !== null && !isOwner && (
          <p className="text-xs text-ink-faint">
            Only an owner can invite, change roles, or remove people.
          </p>
        )}
      </div>
    </Modal>
  );
}

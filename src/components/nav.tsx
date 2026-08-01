"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const LINKS = [
  { href: "/", label: "Book" },
  { href: "/plan", label: "Plan" },
];

export function Nav({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();

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
          <span className="hidden sm:block text-xs text-ink-faint">{email}</span>
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

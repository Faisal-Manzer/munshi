"use client";

import { createClient } from "@/lib/supabase/client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function Login() {
  const [loading, setLoading] = useState(false);
  // where to land afterwards: an MCP consent request sends the user here and
  // needs its own URL back, parameters and all
  const next = useSearchParams().get("next");

  async function signIn() {
    setLoading(true);
    const supabase = createClient();
    const callback = new URL("/auth/callback", location.origin);
    if (next) callback.searchParams.set("next", next);
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback.toString() },
    });
  }

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-sm border border-rule bg-paper-raised p-10 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">
          Personal finance
        </p>
        <h1 className="mt-2 text-4xl">Munshi</h1>
        <p className="mt-3 text-sm text-ink-soft">
          Your munshi keeps the books — accounts, cards, EMIs and everyone
          who owes you money.
        </p>
        <button
          onClick={signIn}
          disabled={loading}
          className="mt-8 w-full border border-ledger bg-ledger text-paper-raised py-2.5 text-sm font-medium hover:opacity-90 disabled:opacity-60"
        >
          {loading ? "Redirecting…" : "Continue with Google"}
        </button>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

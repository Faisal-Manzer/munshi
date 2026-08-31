import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // No email allow-list here any more. It read as a gate but behaved like
      // a suggestion: it ran once, after `exchangeCodeForSession` had already
      // created the `auth.users` row, and it was skipped entirely when the env
      // var was unset — so it failed open, and it never stopped the account
      // from existing. What actually keeps a book private is RLS: every table
      // is scoped through `is_ledger_member(ledger_id)` (migration 008), so a
      // stranger who signs in is a member of nothing and sees an empty app.
      // If signups ever need restricting, that belongs on `auth.users` in
      // Postgres where it cannot fail open, not on one route here.
      //
      // only a path on this origin: an open redirect here would let a
      // crafted sign-in link bounce a signed-in user anywhere
      const next = searchParams.get("next");
      const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      return NextResponse.redirect(`${origin}${safe}`);
    }
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}

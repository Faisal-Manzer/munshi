import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const allowed = (process.env.ALLOWED_EMAILS ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const email = user?.email?.toLowerCase() ?? "";
      if (allowed.length > 0 && !allowed.includes(email)) {
        await supabase.auth.signOut();
        return NextResponse.redirect(`${origin}/login?error=not-allowed`);
      }
      return NextResponse.redirect(`${origin}/`);
    }
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}

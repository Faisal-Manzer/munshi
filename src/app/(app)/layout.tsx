import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { LedgerProvider } from "@/lib/ledger-context";
import { VaultProvider } from "@/lib/e2ee/vault-context";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <VaultProvider>
      <LedgerProvider>
      <div className="flex-1 flex flex-col">
        <Nav email={user.email ?? ""} />
        <main className="flex-1 w-full max-w-[1800px] mx-auto px-4 sm:px-8 py-6">
          {children}
        </main>
      </div>
      </LedgerProvider>
    </VaultProvider>
  );
}

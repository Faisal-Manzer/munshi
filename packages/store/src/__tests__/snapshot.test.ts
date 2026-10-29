import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadLedger } from "@munshi/store";

/** A client that, like PostgREST, never returns more than 1000 rows a request. */
function fakeClient(tables: Record<string, unknown[]>): SupabaseClient {
  const from = (table: string) => {
    let lo = 0;
    let hi = Infinity;
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      range: (a: number, b: number) => {
        lo = a;
        hi = b;
        return q;
      },
      then: (resolve: (r: { data: unknown[]; error: null }) => void) => {
        const rows = tables[table] ?? [];
        const end = Math.min(hi + 1, lo + 1000);
        resolve({ data: rows.slice(lo, end), error: null });
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

describe("loadLedger", () => {
  it("reads every row of a book bigger than one page", async () => {
    const postings = Array.from({ length: 2500 }, (_, i) => ({
      id: `p${i}`,
      transaction_id: "t",
      account_id: "a",
      amount_paise: i % 2 ? 1 : -1,
    }));
    const snap = await loadLedger(fakeClient({ postings, transactions: [], accounts: [] }), "l1", null, {
      withTemplates: false,
    });
    expect(snap.postings).toHaveLength(2500);
  });
});

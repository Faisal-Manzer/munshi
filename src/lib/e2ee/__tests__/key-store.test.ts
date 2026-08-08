import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createIdentity } from "@munshi/crypto";
import { createVault, loadLedgerKeys, loadVault, saveLedgerKey } from "@/lib/e2ee/key-store";

/**
 * The mapping between StoredIdentity and the snake_case row is the one place a
 * silent typo would produce a vault that saves fine and never opens again —
 * the wrong column would simply come back undefined at unlock time. So the
 * round trip is asserted against a fake client rather than trusted.
 */
function fakeSupabase(rows: Record<string, unknown[]> = {}) {
  const inserted: Record<string, unknown[]> = {};
  const client = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: rows[table]?.[0] ?? null, error: null }),
        insert: async (payload: unknown) => {
          (inserted[table] ??= []).push(payload);
          return { error: null };
        },
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: rows[table] ?? [], error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, inserted };
}

const FAST = { m: 512, t: 1, p: 1 };

describe("user_keys round trip", () => {
  it("writes every envelope and reads back an identical StoredIdentity", async () => {
    const { stored } = createIdentity("a long enough passphrase", FAST);
    const { client, inserted } = fakeSupabase();
    await createVault(client, "user-1", stored);

    const row = inserted.user_keys[0] as Record<string, unknown>;
    expect(row.user_id).toBe("user-1");
    expect(row.kdf_memory_kib).toBe(stored.kdf.m);
    expect(row.kdf_iterations).toBe(stored.kdf.t);
    expect(row.kdf_parallelism).toBe(stored.kdf.p);

    const back = await loadVault(fakeSupabase({ user_keys: [row] }).client, "user-1");
    expect(back?.stored).toEqual(stored);
  });

  it("sends no plaintext key material to the server", async () => {
    const { stored, identity, recoveryKey } = createIdentity("passphrase here", FAST);
    const { client, inserted } = fakeSupabase();
    await createVault(client, "user-1", stored);

    const blob = JSON.stringify(inserted.user_keys[0]);
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    expect(blob).not.toContain(b64(identity.masterKey));
    expect(blob).not.toContain(b64(identity.keyPair.privateKey));
    expect(blob).not.toContain(b64(recoveryKey));
    expect(blob).not.toContain("passphrase here");
  });

  it("reports an absent vault as null rather than throwing", async () => {
    expect(await loadVault(fakeSupabase().client, "nobody")).toBeNull();
  });
});

describe("ledger_keys round trip", () => {
  it("preserves ledger id and version, which the unwrap is bound to", async () => {
    const record = { ledgerId: "ledger-1", version: 2, encryptedKey: "envelope" };
    const { client, inserted } = fakeSupabase();
    await saveLedgerKey(client, "user-1", record);

    const row = inserted.ledger_keys[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      ledger_id: "ledger-1",
      user_id: "user-1",
      version: 2,
      encrypted_key: "envelope",
      granted_by: "user-1",
    });

    const back = await loadLedgerKeys(fakeSupabase({ ledger_keys: [row] }).client, "user-1");
    expect(back).toEqual([record]);
  });
});

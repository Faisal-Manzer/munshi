import { describe, expect, it } from "vitest";
import { randomBytes } from "@munshi/crypto";
import type { Account, Posting, Transaction } from "@munshi/core";
import {
  decryptAccount,
  decryptPosting,
  decryptTransaction,
  encryptAccount,
  encryptPosting,
  encryptTransaction,
} from "@munshi/store";

const key = randomBytes(32);

const account = {
  id: "acc-1",
  ledger_id: "l1",
  name: "ICICI",
  person_name: null,
  credit_limit_paise: 500000,
  reported_balance_paise: -140000,
  kind: "asset",
  subtype: "bank",
} as unknown as Account;

const txn = {
  id: "txn-1",
  ledger_id: "l1",
  date: "2026-08-02",
  description: "Cream Stone Ice Cream",
  status: "done",
  tag: "avoidable",
  notes: "Frazer town",
  reimburse_amount_paise: 25700,
} as unknown as Transaction;

describe("row encryption", () => {
  it("round-trips an account and blanks the plaintext columns", () => {
    const row = encryptAccount(key, account.id, account);
    expect(row.name).toBeNull();
    expect(row.credit_limit_paise).toBeNull();
    expect(row.reported_balance_paise).toBeNull();

    const back = decryptAccount(key, { ...account, ...row } as unknown as Account);
    expect(back.name).toBe("ICICI");
    expect(back.credit_limit_paise).toBe(500000);
    expect(back.reported_balance_paise).toBe(-140000);
  });

  it("round-trips a transaction including tag and note", () => {
    const row = encryptTransaction(key, txn.id, txn);
    const back = decryptTransaction(key, { ...txn, ...row } as unknown as Transaction);
    expect(back).toMatchObject({
      description: "Cream Stone Ice Cream",
      tag: "avoidable",
      notes: "Frazer town",
      reimburse_amount_paise: 25700,
    });
  });

  it("round-trips a negative posting amount", () => {
    const row = encryptPosting(key, "p-1", -51400);
    expect(row.amount_paise).toBeNull();
    const back = decryptPosting(key, { id: "p-1", ...row } as unknown as Posting);
    expect(back.amount_paise).toBe(-51400);
  });

  it("leaks no value into the stored envelope", () => {
    const blob = JSON.stringify(encryptTransaction(key, txn.id, txn));
    expect(blob).not.toContain("Cream Stone");
    expect(blob).not.toContain("Frazer");
    expect(blob).not.toContain("avoidable");
    expect(blob).not.toContain("25700");
  });

  it("refuses a payload moved to a different row", () => {
    // without this, swapping two payloads would quietly swap two amounts
    const a = encryptPosting(key, "p-1", -51400);
    expect(() => decryptPosting(key, { id: "p-2", ...a } as unknown as Posting)).toThrow();
  });

  it("refuses a payload moved to a different table", () => {
    const a = encryptTransaction(key, "same-id", txn);
    expect(() =>
      decryptAccount(key, { id: "same-id", payload: a.payload } as unknown as Account)
    ).toThrow();
  });

  it("refuses another ledger's key", () => {
    const row = encryptPosting(key, "p-1", 100);
    expect(() =>
      decryptPosting(randomBytes(32), { id: "p-1", ...row } as unknown as Posting)
    ).toThrow();
  });

  it("passes pre-migration plaintext rows through untouched", () => {
    // an un-migrated book has no payload and must keep working, locked or not
    const plain = { id: "txn-9", description: "Rent", payload: null } as unknown as Transaction;
    expect(decryptTransaction(null, plain).description).toBe("Rent");
  });

  it("says what to do when the book is encrypted but locked", () => {
    const row = encryptPosting(key, "p-1", 100);
    expect(() => decryptPosting(null, { id: "p-1", ...row } as unknown as Posting)).toThrow(
      /unlock/i
    );
  });
});

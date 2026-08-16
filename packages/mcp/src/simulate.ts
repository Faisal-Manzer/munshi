/**
 * What the book would look like if a batch were applied.
 *
 * The preview's before→after numbers come from running the ops against a copy
 * of the snapshot and folding balances the same way the app does — not from a
 * hand-written "this adds to that". If the calculation layer changes, the
 * preview changes with it, which is the only way the number a user approves
 * can be trusted to be the number they get.
 *
 * Pure, and it never touches storage: the ops here have not been written and
 * may never be.
 */
import type { Account, LedgerOp, Posting, Transaction } from "@munshi/core";
import type { LedgerSnapshot } from "@munshi/store";

/** Ids for rows that do not exist yet; visible only inside a simulation. */
const pendingId = (n: number) => `preview-${n}`;

export function simulate(snapshot: LedgerSnapshot, ops: LedgerOp[]): LedgerSnapshot {
  let accounts = [...snapshot.accounts];
  let transactions = [...snapshot.transactions];
  let postings = [...snapshot.postings];
  let templates = [...snapshot.templates];
  let seq = 0;

  const legs = (transactionId: string, op: Extract<LedgerOp, { postings: unknown }>) =>
    op.postings.map(
      (p): Posting => ({
        id: pendingId(++seq),
        transaction_id: transactionId,
        account_id: p.account_id,
        amount_paise: p.amount_paise,
      })
    );

  for (const op of ops) {
    switch (op.kind) {
      case "entry.create": {
        const id = pendingId(++seq);
        transactions = [
          ...transactions,
          {
            id,
            ledger_id: op.ledgerId,
            date: op.txn.date,
            description: op.txn.description,
            status: op.txn.status,
            tag: op.txn.tag ?? null,
            notes: op.txn.notes ?? null,
            recurring_template_id: op.txn.recurringTemplateId ?? null,
            reimburse_account_id: op.txn.reimburseAccountId ?? null,
            reimburse_amount_paise: op.txn.reimbursePaise ?? null,
          },
        ];
        postings = [...postings, ...legs(id, op)];
        break;
      }
      case "entry.rewrite": {
        transactions = transactions.map((t) =>
          t.id === op.transactionId
            ? {
                ...t,
                date: op.txn.date,
                description: op.txn.description,
                status: op.txn.status,
                tag: op.txn.tag ?? null,
                notes: op.txn.notes ?? null,
                reimburse_account_id: op.txn.reimburseAccountId ?? null,
                reimburse_amount_paise: op.txn.reimbursePaise ?? null,
              }
            : t
        );
        postings = [
          ...postings.filter((p) => p.transaction_id !== op.transactionId),
          ...legs(op.transactionId, op),
        ];
        break;
      }
      case "entry.patch": {
        transactions = transactions.map((t) =>
          t.id === op.current.id ? { ...t, ...op.patch } : t
        );
        break;
      }
      case "entry.delete": {
        transactions = transactions.filter((t) => t.id !== op.transactionId);
        postings = postings.filter((p) => p.transaction_id !== op.transactionId);
        break;
      }
      case "account.create": {
        accounts = [...accounts, { ...op.account, user_id: "" } as Account];
        break;
      }
      case "account.update": {
        accounts = accounts.map((a) =>
          a.id === op.current.id ? { ...a, ...op.patch } : a
        );
        break;
      }
      case "template.create": {
        templates = [...templates, { ...op.template }];
        break;
      }
      case "template.update": {
        templates = templates.map((t) =>
          t.id === op.current.id ? { ...t, ...op.patch } : t
        );
        break;
      }
    }
  }

  return { accounts, transactions, postings, templates };
}

/** Every account a batch writes to, posts against, or reads a balance for. */
export function touchedAccountIds(ops: LedgerOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    switch (op.kind) {
      case "entry.create":
      case "entry.rewrite":
        op.postings.forEach((p) => ids.add(p.account_id));
        break;
      case "account.create":
        ids.add(op.account.id);
        break;
      case "account.update":
        ids.add(op.current.id);
        break;
      case "template.create":
        ids.add(op.template.from_account_id);
        ids.add(op.template.to_account_id);
        break;
      case "template.update":
        ids.add(op.current.from_account_id);
        ids.add(op.current.to_account_id);
        break;
    }
  }
  return [...ids];
}

/**
 * Accounts a delete or rewrite touches only through rows already in the book.
 *
 * `touchedAccountIds` reads the ops; an `entry.delete` names no account at
 * all, yet removing it moves every account it posted to. Those have to be in
 * the fingerprint too, or a delete could be approved against numbers that
 * silently moved.
 */
export function affectedAccountIds(snapshot: LedgerSnapshot, ops: LedgerOp[]): string[] {
  const ids = new Set(touchedAccountIds(ops));
  const existing = new Set(
    ops.flatMap((op) =>
      op.kind === "entry.delete"
        ? [op.transactionId]
        : op.kind === "entry.rewrite"
          ? [op.transactionId]
          : []
    )
  );
  for (const p of snapshot.postings) {
    if (existing.has(p.transaction_id)) ids.add(p.account_id);
  }
  return [...ids];
}

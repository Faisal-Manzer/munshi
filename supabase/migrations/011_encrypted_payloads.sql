-- E2EE phase 2: encrypted row payloads.
--
-- Values move into a `payload` envelope the server cannot open; only the
-- structure needed to address and sync a row stays readable. Encryption is
-- per ledger and opt-in: `ledgers.encrypted_at` marks a book as migrated, so
-- an un-migrated book keeps working exactly as before and the two formats
-- coexist during rollout.
--
-- What the server can still see after this, deliberately: row ids, ledger and
-- account links, dates, status, account kind/subtype, statement and due days,
-- sort order, timestamps. Never: amounts, descriptions, notes, tags, account
-- or person names, credit limits, reported balances.

-- ------------------------------------------------------------- payloads
alter table accounts             add column payload text;
alter table transactions         add column payload text;
alter table postings             add column payload text;
alter table recurring_templates  add column payload text;

alter table ledgers add column encrypted_at timestamptz;

comment on column accounts.payload is
  'XChaCha20-Poly1305 envelope: name, person_name, credit_limit_paise, reported_balance_paise';
comment on column transactions.payload is
  'XChaCha20-Poly1305 envelope: description, notes, tag, reimburse_amount_paise';
comment on column postings.payload is
  'XChaCha20-Poly1305 envelope: amount_paise';
comment on column recurring_templates.payload is
  'XChaCha20-Poly1305 envelope: name, amount_paise, reimburse_amount_paise, notes';

-- --------------------------------------------------- relax the plaintext
-- The columns being replaced must accept NULL, because after migration the
-- value lives only inside the payload. They are kept (not dropped) so an
-- un-migrated ledger is untouched and a rollback stays possible.
alter table accounts            alter column name drop not null;
alter table transactions        alter column description drop not null;
alter table postings            alter column amount_paise drop not null;
alter table recurring_templates alter column name drop not null;
alter table recurring_templates alter column amount_paise drop not null;

-- `amount_paise <> 0` cannot hold for a row whose amount is now ciphertext.
alter table postings drop constraint postings_amount_paise_check;
alter table postings add constraint postings_amount_present
  check (amount_paise is not null or payload is not null);
alter table postings add constraint postings_amount_nonzero
  check (amount_paise is null or amount_paise <> 0);

-- --------------------------------------------- double-entry moves client-side
-- check_txn_balanced() summed postings.amount_paise to enforce that every
-- transaction totals zero. A server that can verify that sum is a server that
-- can read your amounts, so the check moves to the client (assertBalanced in
-- @munshi/core, called on every write path).
--
-- This is the one guarantee E2EE costs us, and it is recorded here rather than
-- quietly deleted.
drop trigger if exists postings_balanced on postings;

-- ----------------------------------------------------------------- views
-- account_balances and card_cycle_balances aggregated amount_paise, which is
-- ciphertext from here on. Their logic now lives in @munshi/core/balances.ts,
-- verified row-for-row against these views before removal.
drop view if exists account_balances;
drop view if exists card_cycle_balances;

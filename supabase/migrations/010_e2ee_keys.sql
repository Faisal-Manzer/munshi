-- E2EE phase 1: key storage (docs/E2EE.md §2, §9 step 1).
--
-- Ciphertext only. Every column here is either an opaque envelope the server
-- cannot open, or deliberate structural metadata (KDF params, public keys,
-- timestamps) listed verbatim on the product's security page.
--
-- Additive: no existing table is touched. Ledger data stays plaintext until
-- phase 3 migrates it into the encrypted oplog, so this migration is safe to
-- apply to a live book and safe to roll back by dropping the two tables.

-- ------------------------------------------------------------- user_keys
-- One row per user: the wrapped master key and everything needed to unwrap it
-- given a passphrase or a recovery key. The passphrase itself never arrives.
create table user_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- Argon2id parameters. Stored so they can be raised later without
  -- stranding accounts created under the old cost.
  kdf_algo text not null default 'argon2id' check (kdf_algo = 'argon2id'),
  kdf_memory_kib int not null check (kdf_memory_kib between 8192 and 1048576),
  kdf_iterations int not null check (kdf_iterations between 1 and 16),
  kdf_parallelism int not null check (kdf_parallelism between 1 and 8),
  kdf_salt text not null,

  -- masterKey wrapped by the passphrase-derived KEK
  encrypted_master_key text not null,
  -- masterKey wrapped by the recovery key (the printed kit / 24 words)
  master_key_by_recovery text not null,
  -- recovery key wrapped by the masterKey, so an unlocked session can re-show the kit
  recovery_key_by_master text not null,

  -- X25519 identity: public half in the clear (others seal ledger keys to it),
  -- private half wrapped by the masterKey
  public_key text not null,
  encrypted_private_key text not null,

  -- set when the user confirms they have stored the recovery kit
  recovery_confirmed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_keys enable row level security;

-- A user reads and writes only their own keys. There is no policy that lets
-- anyone read another user's row, and nothing here is readable to the server
-- operator in any useful sense anyway.
create policy user_keys_select on user_keys
  for select using (user_id = auth.uid());
create policy user_keys_insert on user_keys
  for insert with check (user_id = auth.uid());
create policy user_keys_update on user_keys
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Public keys must be discoverable to share a ledger: an owner seals the
-- ledger key to an invitee's public key before that invitee is a member.
-- Exposing only (user_id, email, public_key) keeps every wrapped secret private.
create view user_public_keys
  with (security_invoker = true) as
  select k.user_id, lower(u.email) as email, k.public_key
  from user_keys k
  join auth.users u on u.id = k.user_id;

grant select on user_public_keys to authenticated;

-- ----------------------------------------------------------- ledger_keys
-- The per-ledger symmetric key, wrapped once per member. Versioned so removing
-- a member rotates forward (new ops under v+1) without re-encrypting history.
create table ledger_keys (
  ledger_id uuid not null references ledgers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version int not null default 1 check (version > 0),

  -- ledgerKey wrapped by this member's masterKey, or sealed to their public
  -- key until their client re-wraps it under their own master key
  encrypted_key text not null,
  sealed boolean not null default false,

  -- who handed this key over, for the audit trail
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  primary key (ledger_id, user_id, version)
);

alter table ledger_keys enable row level security;

-- Read your own wrapped keys.
create policy ledger_keys_select on ledger_keys
  for select using (user_id = auth.uid());

-- Grant a key to someone: you must be a member of that ledger, and you can
-- only hand out keys for ledgers you hold. Sealing to a public key means the
-- recipient row is written by the granter, so this covers both cases.
create policy ledger_keys_insert on ledger_keys
  for insert with check (
    is_ledger_member(ledger_id)
    and (granted_by is null or granted_by = auth.uid())
  );

-- Re-wrapping your own sealed key under your master key.
create policy ledger_keys_update on ledger_keys
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Revocation: an owner drops a member's wrapped key. Members may also drop
-- their own (leaving a shared book).
create policy ledger_keys_delete on ledger_keys
  for delete using (user_id = auth.uid() or is_ledger_owner(ledger_id));

create index ledger_keys_user_idx on ledger_keys (user_id);

-- ---------------------------------------------------------------- touch
create or replace function touch_user_keys()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger user_keys_touch
  before update on user_keys
  for each row execute function touch_user_keys();

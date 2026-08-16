-- MCP needs an OAuth 2.1 authorization server, and Supabase Auth is not one:
-- it has no dynamic client registration and no authorization-code endpoint a
-- third-party client can drive. So the app becomes its own AS and uses
-- Supabase only to identify the human (docs/MCP.md §1).
--
-- Only two things need a table. Access and refresh tokens are self-contained
-- JWTs, so they are not stored; an authorization code must be one-time-use,
-- which is a fact about the past that no token can carry.

-- --------------------------------------------------------- oauth_clients
-- Dynamic client registration (RFC 7591). Public clients only: an MCP client
-- runs on the user's machine and cannot keep a secret, so PKCE is the proof,
-- not a client_secret.
create table oauth_clients (
  client_id text primary key,
  client_name text not null,
  redirect_uris text[] not null check (array_length(redirect_uris, 1) >= 1),
  created_at timestamptz not null default now()
);

alter table oauth_clients enable row level security;
-- registration happens before anyone is logged in, so this table is written
-- by the route with the service role and is readable to nobody through the API

-- ----------------------------------------------------------- oauth_codes
-- One row per authorization, alive for a minute or two.
--
-- `sealed_key` is the user's ledger key, sealed in the browser to the server's
-- X25519 public key. The row holds ciphertext the database cannot open, and
-- the row is deleted the moment it is exchanged.
create table oauth_codes (
  -- sha256 of the code. The code itself is never stored, so a leaked backup
  -- cannot be replayed against the token endpoint.
  code_hash text primary key,

  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ledger_id uuid not null references ledgers(id) on delete cascade,

  redirect_uri text not null,
  -- PKCE (S256 only; the spec's plain method is not accepted)
  code_challenge text not null,

  sealed_key text not null,
  scope text not null default 'ledger:read ledger:write',

  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table oauth_codes enable row level security;

-- ----------------------------------------------------- oauth_revocations
-- Tokens are stateless, so revoking one is the exception that needs writing
-- down. Holds token ids, never tokens.
create table oauth_revocations (
  jti text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  revoked_at timestamptz not null default now(),
  -- swept once the token would have expired anyway
  expires_at timestamptz not null
);

alter table oauth_revocations enable row level security;

create policy oauth_revocations_select on oauth_revocations
  for select using (user_id = auth.uid());

create index oauth_codes_expiry on oauth_codes (expires_at);
create index oauth_revocations_expiry on oauth_revocations (expires_at);

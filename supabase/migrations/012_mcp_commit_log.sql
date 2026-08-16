-- MCP: the one thing a stateless server still has to remember.
--
-- Proposals live inside their own id, sealed to the server key, so there is no
-- session table and no proposal table (docs/MCP.md §2). What cannot be carried
-- in the token is the fact that a proposal was already applied: a client that
-- retries a commit after a timeout must not write the entry twice.
--
-- Hashes only. No ops, no description, no amount, nothing the payload columns
-- deliberately hide — this table is readable to the operator, so it holds
-- nothing an encrypted book would not.

create table mcp_commit_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  ledger_id uuid not null references ledgers(id) on delete cascade,

  -- sha256 of the canonicalised proposal. A nonce inside the proposal keeps
  -- two identical-looking operations (the same chai twice in a day) from
  -- colliding here.
  proposal_hash text not null,

  -- one line, written by the operation that built the proposal. Present so a
  -- user can read their own MCP history; it names the operation, never the
  -- amounts.
  summary text not null,

  -- ids of the rows the batch produced, for tracing a write back to its
  -- approval
  result_ids uuid[] not null default '{}',

  committed_at timestamptz not null default now(),

  primary key (user_id, proposal_hash)
);

alter table mcp_commit_log enable row level security;

-- A user reads and writes only their own history. There is no update policy:
-- an audit row that can be edited is not an audit row.
create policy mcp_commit_log_select on mcp_commit_log
  for select using (user_id = auth.uid());

create policy mcp_commit_log_insert on mcp_commit_log
  for insert with check (user_id = auth.uid());

create index mcp_commit_log_recent on mcp_commit_log (user_id, committed_at desc);

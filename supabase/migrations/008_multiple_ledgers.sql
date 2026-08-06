-- Multiple ledgers, one account (VISION §2 + §3 seed).
-- Every data row gets a ledger_id; membership and roles are per-ledger.
-- The old single shared ledger (email-list ledger_members) becomes the
-- "Personal" ledger; any non-member user gets their own private ledger.

-- ---------------------------------------------------------------- ledgers
create table ledgers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create type ledger_role as enum ('owner', 'editor', 'viewer');

-- membership by email so people can be invited before first sign-in
create table ledger_memberships (
  ledger_id uuid not null references ledgers(id) on delete cascade,
  email text not null check (email = lower(email)),
  role ledger_role not null default 'editor',
  created_at timestamptz not null default now(),
  primary key (ledger_id, email)
);
alter table ledger_memberships enable row level security;
-- no policies: membership is only reachable through the definer functions below

-- ------------------------------------------------------------- backfill
-- 1. old shared group -> one "Personal" ledger, all as owners
-- 2. any row-owning user outside that group -> their own private ledger
do $$
declare
  personal uuid;
  u record;
  own uuid;
begin
  insert into ledgers (name) values ('Personal') returning id into personal;
  insert into ledger_memberships (ledger_id, email, role)
    select personal, email, 'owner' from ledger_members;

  -- map every historic row owner to a ledger via a temp table
  create temp table user_ledger (user_id uuid primary key, ledger_id uuid);
  insert into user_ledger
    select distinct u2.id, personal
    from auth.users u2
    join ledger_members m on m.email = lower(u2.email);

  for u in
    select distinct t.user_id, au.email
    from (
      select user_id from accounts
      union select user_id from transactions
      union select user_id from recurring_templates
    ) t
    join auth.users au on au.id = t.user_id
    where t.user_id not in (select user_id from user_ledger)
  loop
    insert into ledgers (name) values ('Personal') returning id into own;
    insert into ledger_memberships (ledger_id, email, role)
      values (own, lower(u.email), 'owner');
    insert into user_ledger values (u.user_id, own);
  end loop;

  alter table accounts add column ledger_id uuid references ledgers(id);
  alter table transactions add column ledger_id uuid references ledgers(id);
  alter table postings add column ledger_id uuid references ledgers(id);
  alter table recurring_templates add column ledger_id uuid references ledgers(id);

  update accounts a set ledger_id = ul.ledger_id
    from user_ledger ul where ul.user_id = a.user_id;
  update transactions t set ledger_id = ul.ledger_id
    from user_ledger ul where ul.user_id = t.user_id;
  update postings p set ledger_id = t.ledger_id
    from transactions t where t.id = p.transaction_id;
  update recurring_templates r set ledger_id = ul.ledger_id
    from user_ledger ul where ul.user_id = r.user_id;

  drop table user_ledger;
end $$;

-- flush the deferred balanced-transaction trigger queued by the postings
-- backfill, or the ALTERs below refuse to run
set constraints all immediate;

alter table accounts alter column ledger_id set not null;
alter table transactions alter column ledger_id set not null;
alter table postings alter column ledger_id set not null;
alter table recurring_templates alter column ledger_id set not null;

create index accounts_ledger_idx on accounts(ledger_id);
create index transactions_ledger_idx on transactions(ledger_id);
create index postings_ledger_idx on postings(ledger_id);
create index recurring_templates_ledger_idx on recurring_templates(ledger_id);

-- ------------------------------------------------- inherit ledger_id
-- postings always belong to their transaction's ledger; child accounts
-- (envelopes, sub-cards) inherit from their parent when not passed.
create or replace function inherit_posting_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select ledger_id into new.ledger_id from transactions where id = new.transaction_id;
  return new;
end $$;
create trigger postings_inherit_ledger
before insert on postings
for each row execute function inherit_posting_ledger();

create or replace function inherit_account_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.ledger_id is null and new.parent_id is not null then
    select ledger_id into new.ledger_id from accounts where id = new.parent_id;
  end if;
  return new;
end $$;
create trigger accounts_inherit_ledger
before insert on accounts
for each row execute function inherit_account_ledger();

-- ---------------------------------------------------------------- RLS
create or replace function is_ledger_member(l uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from ledger_memberships m
    where m.ledger_id = l
      and m.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;

create or replace function can_write_ledger(l uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from ledger_memberships m
    where m.ledger_id = l
      and m.email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and m.role in ('owner', 'editor')
  )
$$;

create or replace function is_ledger_owner(l uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from ledger_memberships m
    where m.ledger_id = l
      and m.email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and m.role = 'owner'
  )
$$;

alter table ledgers enable row level security;
create policy "member ledgers" on ledgers for select
  using (is_ledger_member(id));
create policy "owner updates ledger" on ledgers for update
  using (is_ledger_owner(id)) with check (is_ledger_owner(id));

drop policy "own or shared accounts" on accounts;
drop policy "own or shared transactions" on transactions;
drop policy "own or shared postings" on postings;
drop policy "own or shared recurring" on recurring_templates;

create policy "member reads accounts" on accounts for select
  using (is_ledger_member(ledger_id));
create policy "editor writes accounts" on accounts for insert
  with check (can_write_ledger(ledger_id));
create policy "editor updates accounts" on accounts for update
  using (can_write_ledger(ledger_id)) with check (can_write_ledger(ledger_id));
create policy "editor deletes accounts" on accounts for delete
  using (can_write_ledger(ledger_id));

create policy "member reads transactions" on transactions for select
  using (is_ledger_member(ledger_id));
create policy "editor writes transactions" on transactions for insert
  with check (can_write_ledger(ledger_id));
create policy "editor updates transactions" on transactions for update
  using (can_write_ledger(ledger_id)) with check (can_write_ledger(ledger_id));
create policy "editor deletes transactions" on transactions for delete
  using (can_write_ledger(ledger_id));

create policy "member reads postings" on postings for select
  using (is_ledger_member(ledger_id));
create policy "editor writes postings" on postings for insert
  with check (can_write_ledger(ledger_id));
create policy "editor updates postings" on postings for update
  using (can_write_ledger(ledger_id)) with check (can_write_ledger(ledger_id));
create policy "editor deletes postings" on postings for delete
  using (can_write_ledger(ledger_id));

create policy "member reads recurring" on recurring_templates for select
  using (is_ledger_member(ledger_id));
create policy "editor writes recurring" on recurring_templates for insert
  with check (can_write_ledger(ledger_id));
create policy "editor updates recurring" on recurring_templates for update
  using (can_write_ledger(ledger_id)) with check (can_write_ledger(ledger_id));
create policy "editor deletes recurring" on recurring_templates for delete
  using (can_write_ledger(ledger_id));

-- ------------------------------------------------------------ functions
-- creating a ledger: anyone signed in; creator becomes owner
create or replace function ledger_create(ledger_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  caller text := lower(coalesce(auth.jwt() ->> 'email', ''));
  l uuid;
begin
  if caller = '' then raise exception 'Not signed in.'; end if;
  if ledger_name is null or length(trim(ledger_name)) = 0 then
    raise exception 'Ledger needs a name.';
  end if;
  insert into ledgers (name) values (trim(ledger_name)) returning id into l;
  insert into ledger_memberships (ledger_id, email, role) values (l, caller, 'owner');
  return l;
end $$;

-- members list for a ledger the caller belongs to
drop function if exists ledger_members_list();
create or replace function ledger_members_list(l uuid)
returns table (email text, role ledger_role)
language sql stable security definer set search_path = public as $$
  select m.email, m.role from ledger_memberships m
  where m.ledger_id = l and is_ledger_member(l)
  order by m.role, m.email;
$$;

drop function if exists ledger_member_add(text);
create or replace function ledger_member_add(l uuid, new_email text, new_role ledger_role default 'editor')
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_ledger_owner(l) then
    raise exception 'Only an owner can add members.';
  end if;
  if new_email is null or position('@' in new_email) = 0 then
    raise exception 'Not an email address.';
  end if;
  insert into ledger_memberships (ledger_id, email, role)
  values (l, lower(trim(new_email)), new_role)
  on conflict (ledger_id, email) do update set role = excluded.role;
end $$;

drop function if exists ledger_member_remove(text);
create or replace function ledger_member_remove(l uuid, old_email text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_ledger_owner(l) then
    raise exception 'Only an owner can remove members.';
  end if;
  if lower(trim(old_email)) = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'You cannot remove your own email.';
  end if;
  delete from ledger_memberships
  where ledger_id = l and email = lower(trim(old_email));
end $$;

-- old single-ledger machinery retired
drop function if exists is_shared_row(uuid);
drop table ledger_members;

-- ------------------------------------------------------------------ views
-- recreate (column list changes, so replace is not allowed)
drop view account_balances;
create view account_balances with (security_invoker = true) as
select
  a.id as account_id,
  a.user_id,
  a.ledger_id,
  coalesce(sum(p.amount_paise), 0) as balance_paise,
  coalesce(sum(p.amount_paise) filter (where t.status = 'done'), 0) as settled_paise,
  coalesce(sum(p.amount_paise) filter (where t.status = 'pending'), 0) as pending_paise
from accounts a
left join postings p on p.account_id = a.id
left join transactions t on t.id = p.transaction_id
group by a.id, a.user_id, a.ledger_id;

drop view card_cycle_balances;
create view card_cycle_balances with (security_invoker = true) as
select
  a.id as account_id,
  a.user_id,
  a.ledger_id,
  stmt_cutoff(coalesce(a.statement_day, pa.statement_day)) as cutoff,
  coalesce(sum(p.amount_paise) filter (where t.date <= stmt_cutoff(coalesce(a.statement_day, pa.statement_day))), 0) as billed_paise,
  coalesce(sum(p.amount_paise) filter (where t.date > stmt_cutoff(coalesce(a.statement_day, pa.statement_day)) and p.amount_paise > 0), 0) as payments_since_paise,
  coalesce(sum(p.amount_paise) filter (where t.date > stmt_cutoff(coalesce(a.statement_day, pa.statement_day)) and p.amount_paise < 0), 0) as spends_since_paise
from accounts a
left join accounts pa on pa.id = a.parent_id
left join postings p on p.account_id = a.id
left join transactions t on t.id = p.transaction_id and t.status = 'done'
where a.subtype = 'credit_card'
group by a.id, a.user_id, a.ledger_id, a.statement_day, pa.statement_day;

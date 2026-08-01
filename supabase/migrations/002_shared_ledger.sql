-- Multiple Google accounts, one ledger.
-- Emails in ledger_members all see/edit the same rows (any row owned by a member).
-- Everyone else keeps a private per-user ledger.

create table ledger_members (
  email text primary key check (email = lower(email))
);
alter table ledger_members enable row level security;
-- no policies: clients can't read or change membership; only the definer fn below uses it

create or replace function is_shared_row(row_user uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select
    exists (
      select 1 from ledger_members m
      join auth.users u on lower(u.email) = m.email
      where u.id = row_user
    )
    and exists (
      select 1 from ledger_members m
      where m.email = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
$$;

drop policy "own accounts" on accounts;
drop policy "own transactions" on transactions;
drop policy "own postings" on postings;
drop policy "own recurring" on recurring_templates;

create policy "own or shared accounts" on accounts for all
  using (user_id = auth.uid() or is_shared_row(user_id))
  with check (user_id = auth.uid() or is_shared_row(user_id));
create policy "own or shared transactions" on transactions for all
  using (user_id = auth.uid() or is_shared_row(user_id))
  with check (user_id = auth.uid() or is_shared_row(user_id));
create policy "own or shared postings" on postings for all
  using (user_id = auth.uid() or is_shared_row(user_id))
  with check (user_id = auth.uid() or is_shared_row(user_id));
create policy "own or shared recurring" on recurring_templates for all
  using (user_id = auth.uid() or is_shared_row(user_id))
  with check (user_id = auth.uid() or is_shared_row(user_id));

-- seed: your emails (add more with: insert into ledger_members values ('email');)
insert into ledger_members (email) values ('you@example.com')
on conflict do nothing;

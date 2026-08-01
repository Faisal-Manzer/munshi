-- Manage shared-ledger membership from the app.
-- ledger_members stays policy-less; these definer functions are the only door,
-- and each one requires the caller to already be a member.

create or replace function ledger_members_list()
returns setof text
language sql stable security definer
set search_path = public
as $$
  select email from ledger_members
  where exists (
    select 1 from ledger_members m
    where m.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  order by email;
$$;

create or replace function ledger_member_add(new_email text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from ledger_members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  ) then
    raise exception 'Only existing members can add emails.';
  end if;
  if new_email is null or position('@' in new_email) = 0 then
    raise exception 'Not an email address.';
  end if;
  insert into ledger_members (email) values (lower(trim(new_email)))
  on conflict do nothing;
end;
$$;

create or replace function ledger_member_remove(old_email text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from ledger_members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  ) then
    raise exception 'Only existing members can remove emails.';
  end if;
  if lower(trim(old_email)) = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'You cannot remove your own email.';
  end if;
  delete from ledger_members where email = lower(trim(old_email));
end;
$$;

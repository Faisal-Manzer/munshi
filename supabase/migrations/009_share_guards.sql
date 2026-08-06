-- Sharing guard: the same upsert RPC that invites also changes roles, so an
-- owner must not be able to point it at themselves — demoting the last owner
-- would orphan the book.

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
  if lower(trim(new_email)) = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'You cannot change your own role.';
  end if;
  insert into ledger_memberships (ledger_id, email, role)
  values (l, lower(trim(new_email)), new_role)
  on conflict (ledger_id, email) do update set role = excluded.role;
end $$;

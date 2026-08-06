-- Munshi database checks.
--
-- Runs EVERYTHING inside one transaction and ends with ROLLBACK — the
-- database is byte-for-byte untouched afterwards, so it is safe to point at
-- any environment, including production. Nothing in here ever COMMITs.
--
-- Fixture users/accounts use fixed UUIDs and @example.invalid emails so they
-- can never collide with real data. The deferred balanced-transaction
-- trigger is exercised with SET CONSTRAINTS ... IMMEDIATE, which fires it
-- without committing.
--
-- Run via: npm run test:db   (needs DATABASE_URL)

\set ON_ERROR_STOP on
begin;

create function pg_temp.assert(cond boolean, msg text) returns void
language plpgsql as $$
begin
  if cond is distinct from true then
    raise exception 'ASSERT FAILED: %', msg;
  end if;
end $$;

-- ---------------------------------------------------------------- fixtures
\echo 'fixtures: users + accounts'

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'munshi-dbtest-a@example.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'munshi-dbtest-b@example.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-4333-8333-333333333333',
   'authenticated', 'authenticated', 'munshi-dbtest-c@example.invalid', now(), now());

insert into ledgers (id, name) values
  ('dddddddd-0000-4000-8000-000000000001', 'dbtest ledger A');
insert into ledger_memberships (ledger_id, email, role) values
  ('dddddddd-0000-4000-8000-000000000001', 'munshi-dbtest-a@example.invalid', 'owner');

insert into accounts (id, ledger_id, user_id, name, kind, subtype, statement_day, due_day, parent_id)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'dbtest bank', 'asset', 'bank', null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'dbtest expense', 'expense', 'general_expense', null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'dbtest card', 'liability', 'credit_card', 15, 5, null),
  ('aaaaaaaa-0000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'dbtest subcard', 'liability', 'credit_card', null, null,
   'aaaaaaaa-0000-4000-8000-000000000003');

-- ------------------------------------------------- balanced-transaction trigger
\echo 'test: balanced transaction is accepted'

do $$
declare tid uuid;
begin
  insert into transactions (ledger_id, user_id, date, description)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', current_date, 'dbtest balanced')
  returning id into tid;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000001', -1000),
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000002', 1000);
  set constraints all immediate;
  set constraints all deferred;
end $$;

\echo 'test: unbalanced transaction is rejected at constraint time'

do $$
declare tid uuid;
begin
  begin
    insert into transactions (ledger_id, user_id, date, description)
    values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', current_date, 'dbtest unbalanced')
    returning id into tid;
    insert into postings (user_id, transaction_id, account_id, amount_paise) values
      ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000001', -1000);
    set constraints all immediate;
    raise exception 'UNREACHABLE';
  exception when others then
    if sqlerrm not like '%does not balance%' then
      raise exception 'expected "does not balance", got: %', sqlerrm;
    end if;
  end;
end $$;

\echo 'test: three-leg split transaction balances'

do $$
declare tid uuid; pid uuid := gen_random_uuid();
begin
  insert into accounts (id, ledger_id, user_id, name, kind, subtype, person_name)
  values (pid, 'dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'dbtest person', 'asset', 'receivable', 'dbtest person');
  insert into transactions (ledger_id, user_id, date, description, reimburse_account_id, reimburse_amount_paise)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', current_date, 'dbtest split', pid, 400)
  returning id into tid;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000001', -1000),
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000002', 600),
    ('11111111-1111-4111-8111-111111111111', tid, pid, 400);
  set constraints all immediate;
  set constraints all deferred;
end $$;

-- ---------------------------------------------------------- check constraints
\echo 'test: zero-amount posting is rejected'

do $$
declare tid uuid;
begin
  begin
    insert into transactions (ledger_id, user_id, date, description)
    values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', current_date, 'dbtest zero leg')
    returning id into tid;
    insert into postings (user_id, transaction_id, account_id, amount_paise) values
      ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000001', 0);
    raise exception 'UNREACHABLE';
  exception when check_violation then null;
  end;
end $$;

\echo 'test: statement/due day bounds are enforced'

do $$
begin
  begin
    insert into accounts (ledger_id, user_id, name, kind, subtype, statement_day)
    values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'dbtest bad card', 'liability', 'credit_card', 32);
    raise exception 'UNREACHABLE';
  exception when check_violation then null;
  end;
end $$;

\echo 'test: recurring template constraints (amount > 0, day 1–31)'

do $$
begin
  begin
    insert into recurring_templates (ledger_id, user_id, name, kind, day_of_month, amount_paise, from_account_id, to_account_id)
    values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'dbtest bad tpl', 'manual', 5, 0,
            'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002');
    raise exception 'UNREACHABLE';
  exception when check_violation then null;
  end;
  begin
    insert into recurring_templates (ledger_id, user_id, name, kind, day_of_month, amount_paise, from_account_id, to_account_id)
    values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'dbtest bad tpl', 'manual', 0, 100,
            'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002');
    raise exception 'UNREACHABLE';
  exception when check_violation then null;
  end;
end $$;

\echo 'test: tags are free text (constraint dropped in 004)'

do $$
declare tid uuid;
begin
  insert into transactions (ledger_id, user_id, date, description, tag)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', current_date, 'dbtest free tag', 'any custom tag')
  returning id into tid;
  perform pg_temp.assert(tid is not null, 'free-text tag insert failed');
end $$;

-- ------------------------------------------------------------ delete behaviour
\echo 'test: deleting a transaction cascades to postings; accounts are restricted'

do $$
declare tid uuid; n int;
begin
  insert into transactions (ledger_id, user_id, date, description)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', current_date, 'dbtest cascade')
  returning id into tid;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000001', -5),
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000002', 5);
  delete from transactions where id = tid;
  select count(*) into n from postings where transaction_id = tid;
  perform pg_temp.assert(n = 0, 'postings not cascaded on txn delete');
  -- account with postings can't be deleted (on delete restrict)
  begin
    delete from accounts where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    raise exception 'UNREACHABLE';
  exception when foreign_key_violation then null;
  end;
end $$;

-- ------------------------------------------------------------ account_balances
\echo 'test: account_balances splits settled vs pending'

do $$
declare t1 uuid; t2 uuid; r record;
begin
  insert into transactions (ledger_id, user_id, date, description, status)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', current_date, 'dbtest done spend', 'done')
  returning id into t1;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', t1, 'aaaaaaaa-0000-4000-8000-000000000001', -700),
    ('11111111-1111-4111-8111-111111111111', t1, 'aaaaaaaa-0000-4000-8000-000000000002', 700);
  insert into transactions (ledger_id, user_id, date, description, status)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', current_date, 'dbtest pending spend', 'pending')
  returning id into t2;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', t2, 'aaaaaaaa-0000-4000-8000-000000000001', -300),
    ('11111111-1111-4111-8111-111111111111', t2, 'aaaaaaaa-0000-4000-8000-000000000002', 300);
  set constraints all immediate;
  set constraints all deferred;

  select * into r from account_balances
  where account_id = 'aaaaaaaa-0000-4000-8000-000000000001';
  -- earlier tests booked -1000 (balanced) and -1000 (split) done spends here
  perform pg_temp.assert(r.settled_paise = -700 - 1000 - 1000, 'settled wrong: ' || r.settled_paise);
  perform pg_temp.assert(r.pending_paise = -300, 'pending wrong: ' || r.pending_paise);
  perform pg_temp.assert(r.balance_paise = r.settled_paise + r.pending_paise, 'balance <> settled + pending');
end $$;

-- ------------------------------------------------------------------ stmt_cutoff
\echo 'test: stmt_cutoff properties for representative days'

do $$
declare d int; c date;
begin
  foreach d in array array[1, 15, 28, 31] loop
    c := stmt_cutoff(d);
    perform pg_temp.assert(c <= current_date, format('cutoff(%s) in the future: %s', d, c));
    perform pg_temp.assert(c > current_date - 32, format('cutoff(%s) too old: %s', d, c));
    perform pg_temp.assert(
      extract(day from c)::int = least(d, extract(day from (date_trunc('month', c) + interval '1 month - 1 day'))::int),
      format('cutoff(%s) day mismatch: %s', d, c));
  end loop;
  perform pg_temp.assert(stmt_cutoff(null) = current_date, 'null statement day should mean today');
end $$;

-- ------------------------------------------------------- card_cycle_balances
\echo 'test: card cycle splits billed / payments / unbilled around the cutoff'

do $$
declare c date := stmt_cutoff(15); tid uuid; r record; sub record;
begin
  -- billed: done spend on the cutoff day itself
  insert into transactions (ledger_id, user_id, date, description, status)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', c, 'dbtest billed swipe', 'done') returning id into tid;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000003', -2000),
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000002', 2000);
  -- unbilled: done spend after the cutoff
  insert into transactions (ledger_id, user_id, date, description, status)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', c + 1, 'dbtest unbilled swipe', 'done') returning id into tid;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000003', -300),
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000002', 300);
  -- payment after the cutoff
  insert into transactions (ledger_id, user_id, date, description, status)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', c + 1, 'dbtest bill payment', 'done') returning id into tid;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000001', -500),
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000003', 500);
  -- pending swipe after the cutoff must NOT count
  insert into transactions (ledger_id, user_id, date, description, status)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', c + 1, 'dbtest pending swipe', 'pending') returning id into tid;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000003', -999),
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000002', 999);
  set constraints all immediate;
  set constraints all deferred;

  select * into r from card_cycle_balances
  where account_id = 'aaaaaaaa-0000-4000-8000-000000000003';
  perform pg_temp.assert(r.cutoff = c, 'cutoff mismatch: ' || r.cutoff);
  perform pg_temp.assert(r.billed_paise = -2000, 'billed wrong: ' || r.billed_paise);
  perform pg_temp.assert(r.payments_since_paise = 500, 'payments wrong: ' || r.payments_since_paise);
  perform pg_temp.assert(r.spends_since_paise = -300, 'unbilled wrong (pending leaked?): ' || r.spends_since_paise);

  -- sub-card without its own statement day inherits the parent's cutoff
  select * into sub from card_cycle_balances
  where account_id = 'aaaaaaaa-0000-4000-8000-000000000004';
  perform pg_temp.assert(sub.cutoff = c, 'sub-card cutoff not inherited: ' || sub.cutoff);
end $$;

-- ------------------------------------------------- ledger triggers
\echo 'test: postings + child accounts inherit ledger_id'

do $$
declare tid uuid; cid uuid; l uuid;
begin
  insert into transactions (ledger_id, user_id, date, description)
  values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', current_date, 'dbtest inherit')
  returning id into tid;
  insert into postings (user_id, transaction_id, account_id, amount_paise) values
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000001', -10),
    ('11111111-1111-4111-8111-111111111111', tid, 'aaaaaaaa-0000-4000-8000-000000000002', 10);
  set constraints all immediate;
  set constraints all deferred;
  perform pg_temp.assert(
    (select count(*) from postings where transaction_id = tid
      and ledger_id = 'dddddddd-0000-4000-8000-000000000001') = 2,
    'postings did not inherit the transaction ledger');
  -- child account without explicit ledger_id inherits the parent's
  insert into accounts (user_id, name, kind, subtype, parent_id)
  values ('11111111-1111-4111-8111-111111111111', 'dbtest envelope', 'asset', 'envelope',
          'aaaaaaaa-0000-4000-8000-000000000001')
  returning id into cid;
  select ledger_id into l from accounts where id = cid;
  perform pg_temp.assert(l = 'dddddddd-0000-4000-8000-000000000001',
    'child account did not inherit parent ledger');
end $$;

-- --------------------------------------------------- RLS + per-ledger sharing
\echo 'test: RLS — a member sees the ledger, a stranger sees nothing'

set local role authenticated;
do $$ begin perform set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","email":"munshi-dbtest-a@example.invalid"}', true); end $$;

do $$
declare n int;
begin
  select count(*) into n from accounts where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  perform pg_temp.assert(n = 1, 'owner cannot see own account');
  select count(*) into n from ledgers where id = 'dddddddd-0000-4000-8000-000000000001';
  perform pg_temp.assert(n = 1, 'member cannot see own ledger row');
  -- inserted rows still get user_id from auth.uid()
  insert into accounts (ledger_id, name, kind, subtype)
  values ('dddddddd-0000-4000-8000-000000000001', 'dbtest rls insert', 'asset', 'cash');
  select count(*) into n from accounts
  where name = 'dbtest rls insert' and user_id = '11111111-1111-4111-8111-111111111111';
  perform pg_temp.assert(n = 1, 'auth.uid() default not applied on insert');
end $$;

do $$ begin perform set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","email":"munshi-dbtest-b@example.invalid"}', true); end $$;

do $$
declare n int;
begin
  select count(*) into n from accounts where ledger_id = 'dddddddd-0000-4000-8000-000000000001';
  perform pg_temp.assert(n = 0, 'stranger can see another ledger''s accounts');
  select count(*) into n from ledgers;
  perform pg_temp.assert(n = 0, 'stranger can see another user''s ledger');
  select count(*) into n from account_balances where account_id = 'aaaaaaaa-0000-4000-8000-000000000001';
  perform pg_temp.assert(n = 0, 'stranger can see another ledger''s balances via the view');
  -- writing into someone else's ledger must fail
  begin
    insert into accounts (ledger_id, name, kind, subtype)
    values ('dddddddd-0000-4000-8000-000000000001', 'dbtest intrusion', 'asset', 'cash');
    raise exception 'UNREACHABLE';
  exception when insufficient_privilege then null;
  end;
  -- ledger_memberships has no policies — direct writes must fail
  begin
    insert into ledger_memberships (ledger_id, email)
    values ('dddddddd-0000-4000-8000-000000000001', 'munshi-dbtest-b@example.invalid');
    raise exception 'UNREACHABLE';
  exception when insufficient_privilege then null;
  end;
end $$;

\echo 'test: member RPCs refuse non-owners'

do $$
begin
  begin
    perform ledger_member_add('dddddddd-0000-4000-8000-000000000001', 'munshi-dbtest-x@example.invalid');
    raise exception 'UNREACHABLE';
  exception when others then
    if sqlerrm not like '%Only an owner%' then
      raise exception 'expected owner-only error, got: %', sqlerrm;
    end if;
  end;
end $$;

\echo 'test: shared ledger — an added editor sees and edits the rows'

do $$ begin perform set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","email":"munshi-dbtest-a@example.invalid"}', true); end $$;

do $$
begin
  -- owner adds B as editor (mixed case in, lower-cased out)
  perform ledger_member_add('dddddddd-0000-4000-8000-000000000001', 'Munshi-DBTest-B@Example.Invalid', 'editor');
  perform pg_temp.assert(
    (select count(*) from ledger_members_list('dddddddd-0000-4000-8000-000000000001') m
     where m.email = 'munshi-dbtest-b@example.invalid' and m.role = 'editor') = 1,
    'added member not in list (or not lower-cased)');
  -- garbage input refused
  begin
    perform ledger_member_add('dddddddd-0000-4000-8000-000000000001', 'not-an-email');
    raise exception 'UNREACHABLE';
  exception when others then
    if sqlerrm not like '%Not an email%' then
      raise exception 'expected email validation error, got: %', sqlerrm;
    end if;
  end;
  -- self-removal refused
  begin
    perform ledger_member_remove('dddddddd-0000-4000-8000-000000000001', 'munshi-dbtest-a@example.invalid');
    raise exception 'UNREACHABLE';
  exception when others then
    if sqlerrm not like '%cannot remove your own email%' then
      raise exception 'expected self-removal refusal, got: %', sqlerrm;
    end if;
  end;
end $$;

do $$ begin perform set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","email":"munshi-dbtest-b@example.invalid"}', true); end $$;

do $$
declare n int;
begin
  select count(*) into n from accounts where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  perform pg_temp.assert(n = 1, 'editor cannot see shared account');
  select count(*) into n from account_balances where account_id = 'aaaaaaaa-0000-4000-8000-000000000001';
  perform pg_temp.assert(n = 1, 'editor cannot see shared balances');
  update transactions set notes = 'dbtest shared edit'
  where ledger_id = 'dddddddd-0000-4000-8000-000000000001' and description = 'dbtest free tag';
  select count(*) into n from transactions where notes = 'dbtest shared edit';
  perform pg_temp.assert(n = 1, 'editor cannot edit shared transaction');
  -- editors manage entries, not people: member RPCs stay owner-only
  begin
    perform ledger_member_add('dddddddd-0000-4000-8000-000000000001', 'munshi-dbtest-x@example.invalid');
    raise exception 'UNREACHABLE';
  exception when others then
    if sqlerrm not like '%Only an owner%' then
      raise exception 'expected owner-only error, got: %', sqlerrm;
    end if;
  end;
end $$;

\echo 'test: viewer — reads everything, writes nothing'

do $$ begin perform set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","email":"munshi-dbtest-a@example.invalid"}', true); end $$;
do $$ begin
  perform ledger_member_add('dddddddd-0000-4000-8000-000000000001', 'munshi-dbtest-c@example.invalid', 'viewer');
end $$;

do $$ begin perform set_config('request.jwt.claims',
  '{"sub":"33333333-3333-4333-8333-333333333333","email":"munshi-dbtest-c@example.invalid"}', true); end $$;

do $$
declare n int;
begin
  select count(*) into n from accounts where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  perform pg_temp.assert(n = 1, 'viewer cannot see shared account');
  begin
    insert into transactions (ledger_id, date, description)
    values ('dddddddd-0000-4000-8000-000000000001', current_date, 'dbtest viewer write');
    raise exception 'UNREACHABLE';
  exception when insufficient_privilege then null;
  end;
  begin
    update accounts set name = 'dbtest viewer rename'
    where id = 'aaaaaaaa-0000-4000-8000-000000000001';
    if found then raise exception 'UNREACHABLE'; end if;
  exception when insufficient_privilege then null;
  end;
end $$;

\echo 'test: owner can remove a member'

do $$ begin perform set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","email":"munshi-dbtest-a@example.invalid"}', true); end $$;

do $$
begin
  perform ledger_member_remove('dddddddd-0000-4000-8000-000000000001', 'munshi-dbtest-c@example.invalid');
  perform pg_temp.assert(
    (select count(*) from ledger_members_list('dddddddd-0000-4000-8000-000000000001') m
     where m.email = 'munshi-dbtest-c@example.invalid') = 0,
    'removed member still in list');
end $$;

\echo 'test: ledger_create — caller becomes owner of a fresh private book'

do $$ begin perform set_config('request.jwt.claims',
  '{"sub":"33333333-3333-4333-8333-333333333333","email":"munshi-dbtest-c@example.invalid"}', true); end $$;

do $$
declare l uuid; n int;
begin
  l := ledger_create('dbtest private book');
  select count(*) into n from ledgers where id = l;
  perform pg_temp.assert(n = 1, 'creator cannot see the ledger they created');
  insert into accounts (ledger_id, name, kind, subtype) values (l, 'dbtest private', 'asset', 'cash');
  select count(*) into n from accounts;
  perform pg_temp.assert(n = 1, 'creator sees more than their own rows: ' || n);
  begin
    l := ledger_create('   ');
    raise exception 'UNREACHABLE';
  exception when others then
    if sqlerrm not like '%needs a name%' then
      raise exception 'expected name validation error, got: %', sqlerrm;
    end if;
  end;
end $$;

reset role;

\echo 'ALL DATABASE CHECKS PASSED — rolling everything back'
rollback;

-- Double-entry personal finance ledger
-- Money stored as bigint paise (1 INR = 100 paise). Debits positive, credits negative.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- accounts
create type account_kind as enum ('asset', 'liability', 'income', 'expense', 'equity');
create type account_subtype as enum (
  'bank', 'envelope', 'cash', 'receivable',   -- assets
  'credit_card', 'loan',                       -- liabilities
  'salary', 'other_income',                    -- income
  'general_expense',                           -- expense
  'opening_balance'                            -- equity
);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  name text not null,
  kind account_kind not null,
  subtype account_subtype not null,
  parent_id uuid references accounts(id) on delete restrict, -- envelopes under bank, sub-cards under parent CC
  -- credit card meta
  statement_day int check (statement_day between 1 and 31),
  due_day int check (due_day between 1 and 31),
  credit_limit_paise bigint,
  -- person meta for receivable accounts
  person_name text,
  -- reconciliation: last reported real-world balance (signed like ledger: assets +, liabilities -)
  reported_balance_paise bigint,
  reported_at timestamptz,
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------- transactions
create type txn_status as enum ('pending', 'done');

create table transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  date date not null,
  description text not null,
  status txn_status not null default 'done',
  recurring_template_id uuid, -- fk added after recurring_templates
  -- reimbursement: this txn is expected to be (partly) paid back
  reimburse_account_id uuid references accounts(id), -- receivable account (person)
  reimburse_amount_paise bigint check (reimburse_amount_paise >= 0),
  notes text,
  created_at timestamptz not null default now()
);

create table postings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  transaction_id uuid not null references transactions(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete restrict,
  amount_paise bigint not null check (amount_paise <> 0) -- debit +, credit -
);
create index postings_txn_idx on postings(transaction_id);
create index postings_account_idx on postings(account_id);

-- enforce balanced transactions (deferred, checked at commit)
create or replace function check_txn_balanced() returns trigger
language plpgsql security definer as $$
declare s bigint;
begin
  select coalesce(sum(amount_paise), 0) into s
  from postings where transaction_id = coalesce(new.transaction_id, old.transaction_id);
  if s <> 0 then
    raise exception 'transaction % does not balance (sum = %)',
      coalesce(new.transaction_id, old.transaction_id), s;
  end if;
  return null;
end $$;

create constraint trigger postings_balanced
after insert or update or delete on postings
deferrable initially deferred
for each row execute function check_txn_balanced();

-- ------------------------------------------------------ recurring templates
-- payment mechanics differ: some autodebit from bank (need money there),
-- some autodebit EMI on CC, some manual (rent), some pay-anytime-before-due
create type recurring_kind as enum ('autodebit_bank', 'autodebit_cc', 'manual', 'pay_before_due');

create table recurring_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  name text not null,
  kind recurring_kind not null,
  day_of_month int not null check (day_of_month between 1 and 31),
  amount_paise bigint not null check (amount_paise > 0),
  from_account_id uuid not null references accounts(id), -- credited (bank / CC)
  to_account_id uuid not null references accounts(id),   -- debited (expense / loan liability)
  -- shared loan: expected reimbursement
  reimburse_account_id uuid references accounts(id),
  reimburse_amount_paise bigint check (reimburse_amount_paise >= 0),
  reimburse_expected_day int check (reimburse_expected_day between 1 and 31),
  -- loans: track remaining
  total_installments int,
  installments_done int not null default 0,
  start_date date,
  end_date date,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

alter table transactions
  add constraint transactions_recurring_fk
  foreign key (recurring_template_id) references recurring_templates(id) on delete set null;

-- ------------------------------------------------------------------ views
-- logged balance per account (own postings only; use recursive sum in app for subtree)
create view account_balances with (security_invoker = true) as
select
  a.id as account_id,
  a.user_id,
  coalesce(sum(p.amount_paise), 0) as balance_paise,
  coalesce(sum(p.amount_paise) filter (where t.status = 'done'), 0) as settled_paise,
  coalesce(sum(p.amount_paise) filter (where t.status = 'pending'), 0) as pending_paise
from accounts a
left join postings p on p.account_id = a.id
left join transactions t on t.id = p.transaction_id
group by a.id, a.user_id;

-- ---------------------------------------------------------------- RLS
alter table accounts enable row level security;
alter table transactions enable row level security;
alter table postings enable row level security;
alter table recurring_templates enable row level security;

create policy "own accounts" on accounts for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own transactions" on transactions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own postings" on postings for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own recurring" on recurring_templates for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

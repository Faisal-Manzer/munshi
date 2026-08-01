-- Spend tags + credit-card statement-cycle awareness

alter table transactions add column tag text
  check (tag in ('avoidable', 'partially_avoidable', 'deferrable'));

-- Most recent statement date on/before today for a given statement day (clamped to month end)
create or replace function stmt_cutoff(stmt_day int) returns date
language plpgsql stable as $$
declare cand date; prev_end date;
begin
  if stmt_day is null then return current_date; end if;
  cand := make_date(
    extract(year from current_date)::int,
    extract(month from current_date)::int,
    least(stmt_day, extract(day from (date_trunc('month', current_date) + interval '1 month - 1 day'))::int)
  );
  if cand > current_date then
    prev_end := date_trunc('month', current_date)::date - 1;
    cand := make_date(
      extract(year from prev_end)::int,
      extract(month from prev_end)::int,
      least(stmt_day, extract(day from prev_end)::int)
    );
  end if;
  return cand;
end $$;

-- Per credit card: what the last statement billed vs movement since.
-- billed: net balance up to cutoff (negative = owed on the bill)
-- payments_since: credits you made after cutoff (bill payments)
-- spends_since: new unbilled spends after cutoff (negative)
create view card_cycle_balances with (security_invoker = true) as
select
  a.id as account_id,
  a.user_id,
  stmt_cutoff(coalesce(a.statement_day, pa.statement_day)) as cutoff,
  coalesce(sum(p.amount_paise) filter (where t.date <= stmt_cutoff(coalesce(a.statement_day, pa.statement_day))), 0) as billed_paise,
  coalesce(sum(p.amount_paise) filter (where t.date > stmt_cutoff(coalesce(a.statement_day, pa.statement_day)) and p.amount_paise > 0), 0) as payments_since_paise,
  coalesce(sum(p.amount_paise) filter (where t.date > stmt_cutoff(coalesce(a.statement_day, pa.statement_day)) and p.amount_paise < 0), 0) as spends_since_paise
from accounts a
left join accounts pa on pa.id = a.parent_id
left join postings p on p.account_id = a.id
left join transactions t on t.id = p.transaction_id and t.status = 'done'
where a.subtype = 'credit_card'
group by a.id, a.user_id, a.statement_day, pa.statement_day;

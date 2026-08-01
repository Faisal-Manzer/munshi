-- Liquidity is per-account, not guessed from subtype.
-- Backfill matches the old behaviour (banks, cash, envelopes are liquid),
-- but any account can now be flipped — a locked FD bank not liquid,
-- a liquid fund investment liquid, etc.

alter table accounts add column is_liquid boolean not null default false;

update accounts set is_liquid = true where subtype in ('bank', 'cash', 'envelope');

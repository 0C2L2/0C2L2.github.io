-- Adds "lab" as a fourth kind next to opportunity / event / post (university research labs).
-- Run once in Supabase → SQL Editor. Safe to re-run.
alter table public.opportunities drop constraint if exists opportunities_kind_check;
alter table public.opportunities add constraint opportunities_kind_check
  check (kind in ('opportunity', 'event', 'post', 'lab'));

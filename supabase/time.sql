-- Work-hours tracking: projects on time entries, and whether an entry came from the timer or was added by hand.
-- Run once in Supabase → SQL Editor (after planner.sql). Safe to re-run.
alter table public.focus_sessions add column if not exists project text;
alter table public.focus_sessions add column if not exists source text not null default 'timer';
alter table public.focus_sessions drop constraint if exists focus_sessions_source_check;
alter table public.focus_sessions add constraint focus_sessions_source_check check (source in ('timer', 'manual'));
create index if not exists focus_project on public.focus_sessions (project);

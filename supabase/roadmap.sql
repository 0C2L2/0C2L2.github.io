-- Learning roadmap progress: one row per finished lesson (lesson ids come from roadmap.js).
-- Run once in Supabase → SQL Editor (after planner.sql). Safe to re-run.
create table if not exists public.roadmap_progress (
  lesson_id text primary key check (length(lesson_id) between 1 and 200),
  done_at timestamptz not null default now(),
  note text check (note is null or length(note) <= 2000)
);
alter table public.roadmap_progress enable row level security;
drop policy if exists "admin only" on public.roadmap_progress;
create policy "admin only" on public.roadmap_progress for all to authenticated using (public.is_admin()) with check (public.is_admin());

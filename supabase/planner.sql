-- Planner: tasks + schedule events, notes, focus-timer sessions. Owner-only.
-- Run once in Supabase → SQL Editor (after schema.sql). Safe to re-run.

-- tasks and calendar events share one table:
--   kind 'task'  = a to-do; due_date for a day, or start_at/end_at to block time for it
--   kind 'event' = something on the schedule (class, meeting); can repeat
create table if not exists public.tasks (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null default 'task' check (kind in ('task', 'event')),
  title          text not null,
  notes          text,
  status         text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  priority       smallint not null default 2 check (priority between 1 and 3),   -- 1 high · 2 normal · 3 low
  due_date       date,
  start_at       timestamptz,
  end_at         timestamptz,
  repeat         text not null default 'none' check (repeat in ('none', 'daily', 'weekdays', 'weekly', 'monthly')),
  repeat_until   date,
  tags           text[] not null default '{}',
  checklist      jsonb not null default '[]'::jsonb,                              -- [{ "text": "...", "done": false }]
  opportunity_id uuid references public.opportunities(id) on delete set null,
  estimate_min   integer check (estimate_min is null or estimate_min > 0),
  done_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_at is null or start_at is null or end_at >= start_at)
);
create index if not exists tasks_due on public.tasks (due_date);
create index if not exists tasks_start on public.tasks (start_at);
drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();
alter table public.tasks enable row level security;
drop policy if exists "admin only" on public.tasks;
create policy "admin only" on public.tasks for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table if not exists public.notes (
  id             uuid primary key default gen_random_uuid(),
  title          text not null default '',
  body           text not null default '',
  pinned         boolean not null default false,
  tags           text[] not null default '{}',
  opportunity_id uuid references public.opportunities(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
drop trigger if exists notes_touch on public.notes;
create trigger notes_touch before update on public.notes for each row execute function public.touch_updated_at();
alter table public.notes enable row level security;
drop policy if exists "admin only" on public.notes;
create policy "admin only" on public.notes for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- one row per finished focus block (pomodoro or stopwatch)
create table if not exists public.focus_sessions (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid references public.tasks(id) on delete set null,
  label       text,
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  minutes     integer not null check (minutes > 0),
  created_at  timestamptz not null default now()
);
create index if not exists focus_started on public.focus_sessions (started_at);
alter table public.focus_sessions enable row level security;
drop policy if exists "admin only" on public.focus_sessions;
create policy "admin only" on public.focus_sessions for all to authenticated using (public.is_admin()) with check (public.is_admin());

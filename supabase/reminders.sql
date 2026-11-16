-- Planner reminders that arrive even when the site is closed (Web Push).
-- Run once in Supabase → SQL Editor, AFTER planner.sql and after deploying the send-reminders Edge Function. Safe to re-run.

-- when to remind: remind_min minutes before the start (all-day items: before 09:00 that day);
-- remind_at is the next send time, filled in by the planner and moved forward by the function for repeating events
alter table public.tasks add column if not exists remind_min integer check (remind_min is null or remind_min >= 0);
alter table public.tasks add column if not exists remind_at timestamptz;
create index if not exists tasks_remind on public.tasks (remind_at) where remind_at is not null;

-- one row per browser/device that turned reminders on
create table if not exists public.push_subs (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  device     text,
  private    boolean not null default true,   -- true: notifications say "You have a reminder" without the title (shared computers)
  created_at timestamptz not null default now()
);
alter table public.push_subs add column if not exists private boolean not null default true;
alter table public.push_subs enable row level security;
drop policy if exists "admin only" on public.push_subs;
create policy "admin only" on public.push_subs for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- every minute, ask the Edge Function to send whatever is due
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname = 'planner-reminders';
select cron.schedule('planner-reminders', '* * * * *', $cron$
  select net.http_post(
    url     := 'https://nzlqbwdaxkpmkgjipqjy.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- the public anon key (same one as in app.js); the function only sends reminders that are already due
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56bHFid2RheGtwbWtnamlwcWp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0NzM2NjYsImV4cCI6MjExMDA0OTY2Nn0.kDsLcnOrQRw-x6zA7Z3mfy5inXStN2ywIlWhQvI5qxk'),
    body    := '{}'::jsonb);
$cron$);

-- "Book a call" (like Calendly). Run once in Supabase → SQL Editor, after planner.sql and reminders.sql. Safe to re-run.
-- Visitors never read your tasks: they get busy time ranges only (busy_slots) and book through book_slot,
-- which re-checks everything server-side. A booking becomes a "Call with …" event in your planner.

alter table public.tasks add column if not exists remind_min integer;
alter table public.tasks add column if not exists remind_at timestamptz;

-- one row of settings, edited from the planner's Bookings tab
create table if not exists public.booking_settings (
  id              integer primary key default 1 check (id = 1),
  enabled         boolean not null default false,
  title           text not null default 'Book a call with Rashid',
  intro           text not null default 'Pick a time that works for you. Happy to talk about AI/ML, robotics, research or projects.',
  durations       integer[] not null default '{15,30,60}',
  hours           jsonb not null default '{"1":[["10:00","18:00"]],"2":[["10:00","18:00"]],"3":[["10:00","18:00"]],"4":[["10:00","18:00"]],"5":[["10:00","18:00"]],"6":[],"7":[]}',   -- ISO weekday (1 = Mon) → [[start, end]] in tz
  tz              text not null default 'Asia/Seoul',
  min_notice_min  integer not null default 720 check (min_notice_min >= 0),
  max_days        integer not null default 30 check (max_days between 1 and 90),
  buffer_min      integer not null default 10 check (buffer_min between 0 and 120),
  location        text not null default 'Google Meet (link shown after booking)',   -- public description
  location_detail text,                                                              -- private: only shown to someone who booked
  updated_at      timestamptz not null default now()
);
insert into public.booking_settings (id) values (1) on conflict (id) do nothing;
drop trigger if exists booking_settings_touch on public.booking_settings;
create trigger booking_settings_touch before update on public.booking_settings for each row execute function public.touch_updated_at();
alter table public.booking_settings enable row level security;
drop policy if exists "admin only" on public.booking_settings;
create policy "admin only" on public.booking_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table if not exists public.bookings (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid references public.tasks(id) on delete set null,
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  minutes         integer not null,
  name            text not null,
  email           text not null,
  note            text,
  status          text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  cancel_token    uuid not null default gen_random_uuid(),
  ip_hash         text,
  notified        boolean not null default false,
  cancel_notified boolean not null default false,
  created_at      timestamptz not null default now(),
  cancelled_at    timestamptz
);
create index if not exists bookings_start on public.bookings (start_at);
create unique index if not exists bookings_token on public.bookings (cancel_token);
alter table public.bookings enable row level security;
drop policy if exists "admin only" on public.bookings;
create policy "admin only" on public.bookings for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- public page settings (never the private meeting link)
create or replace function public.get_booking_page() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('enabled', enabled, 'title', title, 'intro', intro, 'durations', durations, 'hours', hours, 'tz', tz,
    'min_notice_min', min_notice_min, 'max_days', max_days, 'buffer_min', buffer_min, 'location', location)
  from booking_settings where id = 1;
$$;

-- busy time ranges only (no titles): one-off timed items + repeating events expanded day by day in the booking time zone
create or replace function public.busy_slots(p_from timestamptz, p_to timestamptz)
returns table (start_at timestamptz, end_at timestamptz)
language sql stable security definer set search_path = public as $$
  with s as (select tz from booking_settings where id = 1),
       w as (select p_from as a, least(p_to, p_from + interval '62 days') as b)
  select t.start_at, coalesce(t.end_at, t.start_at + make_interval(mins => coalesce(t.estimate_min, 60)))
  from tasks t, w
  where t.start_at is not null and t.repeat = 'none' and t.status <> 'done'
    and t.start_at < w.b and coalesce(t.end_at, t.start_at + interval '1 hour') > w.a
  union all
  select (d::date + (t.start_at at time zone s.tz)::time) at time zone s.tz,
         (d::date + (t.start_at at time zone s.tz)::time) at time zone s.tz + coalesce(t.end_at - t.start_at, interval '1 hour')
  from tasks t, s, w, generate_series((w.a at time zone s.tz)::date, (w.b at time zone s.tz)::date, interval '1 day') d
  where t.kind = 'event' and t.repeat <> 'none' and t.start_at is not null
    and d::date >= (t.start_at at time zone s.tz)::date and (t.repeat_until is null or d::date <= t.repeat_until)
    and case t.repeat
          when 'daily' then true
          when 'weekdays' then extract(isodow from d) < 6
          when 'weekly' then extract(isodow from d) = extract(isodow from t.start_at at time zone s.tz)
          when 'monthly' then extract(day from d) = extract(day from t.start_at at time zone s.tz)
          else false end;
$$;

create or replace function public.book_slot(p_start timestamptz, p_minutes integer, p_name text, p_email text, p_note text default '')
returns json language plpgsql security definer set search_path = public as $$
declare
  s booking_settings; v_end timestamptz; lt timestamp; ok boolean; ip text; tid uuid; b bookings; buf interval;
begin
  select * into s from booking_settings where id = 1;
  if s.id is null or not s.enabled then raise exception 'Booking is closed right now.'; end if;
  if p_minutes is null or not (p_minutes = any (s.durations)) then raise exception 'Please pick one of the offered call lengths.'; end if;
  p_name := btrim(coalesce(p_name, '')); p_email := lower(btrim(coalesce(p_email, ''))); p_note := left(btrim(coalesce(p_note, '')), 1000);
  if length(p_name) < 2 or length(p_name) > 80 then raise exception 'Please enter your name.'; end if;
  if length(p_email) > 120 or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Please enter a valid email address.'; end if;
  if extract(epoch from p_start)::bigint % 300 <> 0 then raise exception 'That is not a valid start time.'; end if;
  v_end := p_start + make_interval(mins => p_minutes);
  if p_start < now() + make_interval(mins => s.min_notice_min) then raise exception 'That time is too soon to book.'; end if;
  if p_start > now() + make_interval(days => s.max_days) then raise exception 'That time is too far ahead.'; end if;
  lt := p_start at time zone s.tz;
  select exists (
    select 1 from jsonb_array_elements(coalesce(s.hours -> extract(isodow from lt)::int::text, '[]'::jsonb)) r
    where lt::time >= (r ->> 0)::time and (lt + make_interval(mins => p_minutes))::time <= (r ->> 1)::time
      and (lt + make_interval(mins => p_minutes))::date = lt::date) into ok;
  if not ok then raise exception 'That time is outside the booking hours.'; end if;
  ip := coalesce(nullif(btrim(split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1)), ''), 'unknown');
  if (select count(*) from bookings where ip_hash = md5(ip) and created_at > now() - interval '1 day') >= 3 then
    raise exception 'Too many bookings from this network today. Please email me instead.';
  end if;
  perform pg_advisory_xact_lock(hashtext('book_slot'));   -- two visitors can't take the same slot
  buf := make_interval(mins => s.buffer_min);
  if exists (select 1 from busy_slots(p_start - buf - interval '1 day', v_end + buf + interval '1 day') x
             where x.start_at < v_end + buf and x.end_at > p_start - buf) then
    raise exception 'Sorry, that time was just taken. Please pick another one.';
  end if;
  insert into tasks (kind, title, notes, start_at, end_at, tags, remind_min, remind_at)
  values ('event', 'Call with ' || p_name,
          'Booked by ' || p_name || ' <' || p_email || '>' || case when p_note <> '' then E'\n\n' || p_note else '' end,
          p_start, v_end, '{booking}', 10, p_start - interval '10 minutes')
  returning id into tid;
  insert into bookings (task_id, start_at, end_at, minutes, name, email, note, ip_hash)
  values (tid, p_start, v_end, p_minutes, p_name, p_email, nullif(p_note, ''), md5(ip))
  returning * into b;
  return json_build_object('id', b.id, 'cancel_token', b.cancel_token, 'start_at', b.start_at, 'end_at', b.end_at,
                           'minutes', b.minutes, 'location', s.location, 'location_detail', s.location_detail);
end $$;

-- the booker's own link: look up and cancel with the secret token
create or replace function public.booking_by_token(p_token uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('name', name, 'start_at', start_at, 'end_at', end_at, 'minutes', minutes, 'status', status)
  from bookings where cancel_token = p_token;
$$;

create or replace function public.cancel_booking(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare b bookings;
begin
  update bookings set status = 'cancelled', cancelled_at = now()
  where cancel_token = p_token and status = 'confirmed' and start_at > now()
  returning * into b;
  if b.id is null then raise exception 'This booking cannot be cancelled (already cancelled or in the past).'; end if;
  delete from tasks where id = b.task_id;
  return json_build_object('ok', true, 'start_at', b.start_at);
end $$;

grant execute on function public.get_booking_page() to anon, authenticated;
grant execute on function public.busy_slots(timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.book_slot(timestamptz, integer, text, text, text) to anon, authenticated;
grant execute on function public.booking_by_token(uuid) to anon, authenticated;
grant execute on function public.cancel_booking(uuid) to anon, authenticated;

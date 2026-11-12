-- Portfolio backend: opportunities/posts + file sharing with 6-digit codes.
-- Run once in Supabase → SQL Editor. Safe to re-run.
--
-- ⚠ Set YOUR login email on the next statement. Only that account can create,
--   edit, upload or delete. Everyone else can only read public posts and
--   redeem a file code.

create or replace function public.is_admin() returns boolean
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = lower('rashidtagaev01@gmail.com')
$$;

-- ───────────────────────── opportunities / events / posts
create table if not exists public.opportunities (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(title) between 1 and 200),
  kind        text not null default 'opportunity' check (kind in ('opportunity', 'event', 'post', 'lab')),
  org         text,
  location    text,
  url         text check (url is null or url ~* '^https?://'),
  deadline    date,
  status      text not null default 'interested'
              check (status in ('interested', 'applied', 'interview', 'offer', 'rejected', 'done')),
  tags        text[] not null default '{}',
  summary     text,
  body        text,                       -- markdown
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists opportunities_touch on public.opportunities;
create trigger opportunities_touch before update on public.opportunities
  for each row execute function public.touch_updated_at();

alter table public.opportunities enable row level security;
drop policy if exists "read public or admin" on public.opportunities;
create policy "read public or admin" on public.opportunities
  for select using (is_public or public.is_admin());
drop policy if exists "admin writes" on public.opportunities;
create policy "admin writes" on public.opportunities
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────── files + share codes
create table if not exists public.files (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  path        text not null unique,      -- '<uuid>/<filename>' in the 'files' bucket
  size        bigint,
  mime        text,
  code        char(6) unique,            -- null = sharing revoked; never expires
  downloads   integer not null default 0,
  created_at  timestamptz not null default now()
);

-- crypto-random 6 digits, unique among active codes
create or replace function public.new_file_code() returns char(6)
language plpgsql volatile as $$
declare c char(6);
begin
  loop
    c := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.files where code = c);
  end loop;
  return c;
end $$;

create or replace function public.files_default_code() returns trigger
language plpgsql as $$ begin if new.code is null then new.code := public.new_file_code(); end if; return new; end $$;
drop trigger if exists files_code on public.files;
create trigger files_code before insert on public.files
  for each row execute function public.files_default_code();

alter table public.files enable row level security;
drop policy if exists "admin only" on public.files;
create policy "admin only" on public.files
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────── redeem a code (no login), rate limited per IP
create table if not exists public.code_attempts (
  ip  text not null,
  at  timestamptz not null default now()
);
create index if not exists code_attempts_ip_at on public.code_attempts (ip, at);
alter table public.code_attempts enable row level security;   -- no policies: only the function below touches it

create or replace function public.redeem_code(p_code text)
returns table (name text, path text, size bigint, mime text)
language plpgsql security definer set search_path = public as $$
declare
  hdrs  json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  v_ip  text := coalesce(hdrs ->> 'cf-connecting-ip', nullif(split_part(hdrs ->> 'x-forwarded-for', ',', 1), ''), 'unknown');
  f     public.files;
begin
  if p_code is null or p_code !~ '^[0-9]{6}$' then
    raise exception 'Enter the 6-digit code.';
  end if;
  delete from public.code_attempts where at < now() - interval '1 day';
  if (select count(*) from public.code_attempts a where a.ip = v_ip and a.at > now() - interval '10 minutes') >= 10 then
    raise exception 'Too many wrong codes. Try again in 10 minutes.';
  end if;
  select * into f from public.files x where x.code = p_code;
  if not found then
    insert into public.code_attempts (ip) values (v_ip);      -- only wrong guesses count
    return;
  end if;
  update public.files x set downloads = x.downloads + 1 where x.id = f.id;
  return query select f.name, f.path, f.size, f.mime;
end $$;
revoke all on function public.redeem_code(text) from public;
grant execute on function public.redeem_code(text) to anon, authenticated;

-- admin: issue a fresh code for a file (old code stops working)
create or replace function public.regenerate_code(p_id uuid) returns char(6)
language plpgsql security invoker as $$
declare c char(6) := public.new_file_code();
begin
  update public.files set code = c where id = p_id;   -- RLS: only the admin can update
  if not found then raise exception 'File not found.'; end if;
  return c;
end $$;

-- ───────────────────────── storage bucket
-- Public bucket, but objects live under a random uuid folder and anonymous users
-- have no list permission, so a file is reachable only through its code (or its
-- full URL). Free plan caps each file at 50 MB.
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

drop policy if exists "files: admin read" on storage.objects;
create policy "files: admin read" on storage.objects
  for select to authenticated using (bucket_id = 'files' and public.is_admin());
drop policy if exists "files: admin upload" on storage.objects;
create policy "files: admin upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'files' and public.is_admin());
drop policy if exists "files: admin update" on storage.objects;
create policy "files: admin update" on storage.objects
  for update to authenticated using (bucket_id = 'files' and public.is_admin());
drop policy if exists "files: admin delete" on storage.objects;
create policy "files: admin delete" on storage.objects
  for delete to authenticated using (bucket_id = 'files' and public.is_admin());

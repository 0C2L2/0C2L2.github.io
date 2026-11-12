-- Application kits: per-opportunity files, a tailored email and a tailored CV,
-- plus the master profile the CV builder picks from. Run once in Supabase → SQL Editor
-- (after schema.sql). Safe to re-run. Everything here is owner-only.

-- files can belong to an opportunity (null = general file); deleting the opportunity removes the link rows
alter table public.files add column if not exists opportunity_id uuid references public.opportunities(id) on delete cascade;
create index if not exists files_opportunity on public.files (opportunity_id);

-- master profile: every experience, project, skill… once; CVs pick from here
create table if not exists public.profile_items (
  id          uuid primary key default gen_random_uuid(),
  section     text not null check (section in ('experience', 'project', 'education', 'skill', 'certification', 'award', 'language')),
  title       text not null,
  subtitle    text,                      -- role, degree, issuer…
  place       text,                      -- organisation / location
  dates       text,                      -- free text, e.g. 'Sept 2026 – present'
  bullets     text[] not null default '{}',
  tags        text[] not null default '{}',   -- robotics, vision, autonomy, speech, web, product, research…
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
alter table public.profile_items enable row level security;
drop policy if exists "admin only" on public.profile_items;
create policy "admin only" on public.profile_items
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- one kit per opportunity: the email draft and the CV selection
-- cv = { "headline": text, "summary": text,
--        "items": [ { "id": <profile_items.id>, "bullets": [text, …] }, … ] }   -- order = order on the CV
create table if not exists public.app_kits (
  opportunity_id  uuid primary key references public.opportunities(id) on delete cascade,
  email_to        text,
  email_subject   text,
  email_body      text,
  cv              jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);
drop trigger if exists app_kits_touch on public.app_kits;
create trigger app_kits_touch before update on public.app_kits
  for each row execute function public.touch_updated_at();
alter table public.app_kits enable row level security;
drop policy if exists "admin only" on public.app_kits;
create policy "admin only" on public.app_kits
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

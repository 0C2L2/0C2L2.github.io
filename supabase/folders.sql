-- Folders for the Files tab (open, move, copy, unzip into). Run once in Supabase → SQL Editor, after schema.sql. Safe to re-run.
create table if not exists public.folders (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 120 and name !~ '[\\/]'),
  parent_id  uuid references public.folders(id) on delete cascade,     -- deleting a folder removes its subfolders
  created_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);
create index if not exists folders_parent on public.folders (parent_id);
alter table public.folders enable row level security;
drop policy if exists "admin only" on public.folders;
create policy "admin only" on public.folders for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- files keep working without a folder (top level); if a folder row disappears, its files fall back to the top level
alter table public.files add column if not exists folder_id uuid references public.folders(id) on delete set null;
create index if not exists files_folder on public.files (folder_id);

-- a folder can't be moved inside one of its own subfolders
create or replace function public.folders_no_cycle() returns trigger language plpgsql as $$
begin
  if new.parent_id is not null and exists (
    with recursive up as (select id, parent_id from public.folders where id = new.parent_id
                          union all select f.id, f.parent_id from public.folders f join up on f.id = up.parent_id)
    select 1 from up where id = new.id) then
    raise exception 'A folder can''t go inside itself.';
  end if;
  return new;
end $$;
drop trigger if exists folders_no_cycle on public.folders;
create trigger folders_no_cycle before insert or update of parent_id on public.folders for each row execute function public.folders_no_cycle();

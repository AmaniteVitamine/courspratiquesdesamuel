-- Maths pratiques de Samuel / V4 — sources LaTeX privees par fichier.
-- À exécuter APRÈS migration_v3.sql. Ne supprime aucun document existant.
-- La source est conservée dans une table distincte, jamais dans resources,
-- puisque les élèves peuvent lire leurs lignes resources.

create table if not exists public.resource_file_sources (
  file_path text primary key,
  resource_id uuid not null references public.resources(id) on delete cascade,
  latex_source text not null check (char_length(latex_source) <= 500000),
  updated_at timestamptz not null default now()
);

create index if not exists resource_file_sources_resource_idx
  on public.resource_file_sources(resource_id);

alter table public.resource_file_sources enable row level security;
revoke all on public.resource_file_sources from anon, authenticated;
grant select, insert, update, delete on public.resource_file_sources to authenticated;

-- Politique d'administration uniquement ; aucune politique de lecture pour les élèves.
drop policy if exists "resource_file_sources_admin_select" on public.resource_file_sources;
create policy "resource_file_sources_admin_select"
  on public.resource_file_sources for select to authenticated
  using (public.is_admin());

drop policy if exists "resource_file_sources_admin_insert" on public.resource_file_sources;
create policy "resource_file_sources_admin_insert"
  on public.resource_file_sources for insert to authenticated
  with check (public.is_admin() and exists (
    select 1 from public.resources r where r.id=resource_id
      and (r.file_path=resource_file_sources.file_path or exists (
        select 1 from public.resource_files f
        where f.resource_id=r.id and f.file_path=resource_file_sources.file_path
      ))
  ));

drop policy if exists "resource_file_sources_admin_update" on public.resource_file_sources;
create policy "resource_file_sources_admin_update"
  on public.resource_file_sources for update to authenticated
  using (public.is_admin())
  with check (public.is_admin() and exists (
    select 1 from public.resources r where r.id=resource_id
      and (r.file_path=resource_file_sources.file_path or exists (
        select 1 from public.resource_files f
        where f.resource_id=r.id and f.file_path=resource_file_sources.file_path
      ))
  ));

drop policy if exists "resource_file_sources_admin_delete" on public.resource_file_sources;
create policy "resource_file_sources_admin_delete"
  on public.resource_file_sources for delete to authenticated
  using (public.is_admin());

-- Trigger de mise à jour horodatée (idempotent).
create or replace function public.touch_resource_file_source()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists resource_file_sources_touch on public.resource_file_sources;
create trigger resource_file_sources_touch before update on public.resource_file_sources
  for each row execute function public.touch_resource_file_source();

-- Maths pratiques de Samuel — Espace élèves privé
-- À exécuter UNE SEULE FOIS depuis Supabase > SQL Editor.
-- Les mots de passe ne sont JAMAIS enregistrés dans ces tables : Supabase Auth s'en occupe.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  identifier text not null unique,
  display_name text not null,
  role text not null default 'student' check (role in ('student','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint profiles_identifier_valid check (identifier ~ '^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$')
);

create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 130),
  description text,
  content text,
  category text not null default 'exercices'
    check (category in ('cours','exercices','correction','controle','autre')),
  file_path text,
  file_name text,
  course_date date,
  added_at timestamptz not null default now(),
  constraint resources_need_content_or_file check (
    nullif(btrim(coalesce(content,'')),'') is not null or file_path is not null
  )
);
create index if not exists resources_student_added_idx
  on public.resources (student_id, added_at desc);

-- Fonctions SECURITY DEFINER pour lire la qualité de l'utilisateur sans récursion RLS.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role='admin' and p.active
  );
$$;
create or replace function public.is_active_student()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role='student' and p.active
  );
$$;
revoke all on function public.is_admin() from public;
revoke all on function public.is_active_student() from public;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_active_student() to authenticated;

alter table public.profiles enable row level security;
alter table public.resources enable row level security;

-- Des droits SQL explicites, en complément du RLS.
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.resources from anon, authenticated;
grant select on table public.profiles to authenticated;
-- L'admin peut seulement changer le nom affiché et le statut, jamais s'attribuer un rôle.
grant update (display_name,active) on table public.profiles to authenticated;
grant select,insert,update,delete on table public.resources to authenticated;

drop policy if exists "profiles_view_self_or_admin" on public.profiles;
create policy "profiles_view_self_or_admin" on public.profiles
  for select to authenticated using (
    public.is_admin() or (id=(select auth.uid()) and active)
  );

drop policy if exists "profiles_update_students_admin_only" on public.profiles;
create policy "profiles_update_students_admin_only" on public.profiles
  for update to authenticated
  using (public.is_admin() and role='student')
  with check (public.is_admin() and role='student');

drop policy if exists "resources_read_own_or_admin" on public.resources;
create policy "resources_read_own_or_admin" on public.resources
  for select to authenticated using (
    public.is_admin() or (student_id=(select auth.uid()) and public.is_active_student())
  );

drop policy if exists "resources_admin_insert" on public.resources;
create policy "resources_admin_insert" on public.resources
  for insert to authenticated with check (public.is_admin());

drop policy if exists "resources_admin_update" on public.resources;
create policy "resources_admin_update" on public.resources
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "resources_admin_delete" on public.resources;
create policy "resources_admin_delete" on public.resources
  for delete to authenticated using (public.is_admin());

-- Bucket privé : aucune URL publique permanente.
insert into storage.buckets (id,name,public,file_size_limit)
values ('eleves-documents','eleves-documents',false,15728640)
on conflict (id) do update
set public=false, file_size_limit=15728640;

drop policy if exists "samuel_docs_read_admin_or_owner" on storage.objects;
create policy "samuel_docs_read_admin_or_owner" on storage.objects
  for select to authenticated using (
    bucket_id='eleves-documents' and (
      public.is_admin() or
      (public.is_active_student() and
       (storage.foldername(name))[1]=(select auth.uid())::text)
    )
  );

drop policy if exists "samuel_docs_admin_upload" on storage.objects;
create policy "samuel_docs_admin_upload" on storage.objects
  for insert to authenticated with check (
    bucket_id='eleves-documents' and public.is_admin() and
    lower(storage.extension(name)) in ('pdf','png','jpg','jpeg','webp','docx')
  );

drop policy if exists "samuel_docs_admin_delete" on storage.objects;
create policy "samuel_docs_admin_delete" on storage.objects
  for delete to authenticated using (
    bucket_id='eleves-documents' and public.is_admin()
  );

-- IMPORTANT : créer d'abord ton compte réel dans Supabase Auth > Users.
-- Ensuite exécuter PERSONNELLEMENT cette requête dans SQL Editor
-- en remplaçant par ton adresse e-mail d'administrateur :
--
-- insert into public.profiles (id,identifier,display_name,role)
-- select id,'samuel-admin','Samuel','admin'
-- from auth.users where email = 'TON_EMAIL_ADMIN@EXEMPLE.FR'
-- on conflict (id) do update set role='admin',active=true;
--
-- Ne publie jamais ton mot de passe admin ni de clé privée dans GitHub.

-- Pour une installation neuve, exécuter ensuite migration_v2.sql.

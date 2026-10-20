-- Espace élèves — mise à jour V2 (à lancer une fois OU à relancer sans risque)
-- Préserve les comptes, les ressources et les PDF existants.

-- Pièces jointes supplémentaires pour un même envoi.
create table if not exists public.resource_files (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources(id) on delete cascade,
  file_path text not null unique,
  file_name text not null,
  added_at timestamptz not null default now(),
  constraint resource_files_path_has_owner check (length(file_path) between 4 and 500)
);
create index if not exists resource_files_resource_idx on public.resource_files(resource_id);

alter table public.resource_files enable row level security;
revoke all on public.resource_files from anon, authenticated;
grant select,insert,delete on public.resource_files to authenticated;

drop policy if exists "resource_files_select_owner_or_admin" on public.resource_files;
create policy "resource_files_select_owner_or_admin" on public.resource_files
 for select to authenticated using (
   public.is_admin() or exists (
     select 1 from public.resources r
     where r.id=resource_id and r.student_id=(select auth.uid())
       and public.is_active_student()
   )
 );
drop policy if exists "resource_files_admin_insert" on public.resource_files;
create policy "resource_files_admin_insert" on public.resource_files
 for insert to authenticated with check (
   public.is_admin() and exists (
     select 1 from public.resources r where r.id=resource_id
     and split_part(file_path,'/',1)=r.student_id::text
   )
 );
drop policy if exists "resource_files_admin_delete" on public.resource_files;
create policy "resource_files_admin_delete" on public.resource_files
 for delete to authenticated using (public.is_admin());

-- Discussion attachée à un document (historique étudiant / administration).
-- Écriture interdite directement depuis un navigateur : seule la fonction serveur
-- send-message vérifie les droits et crée les messages.
create table if not exists public.resource_messages (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  sender_role text not null check (sender_role in ('student','admin')),
  body text not null check (length(btrim(body)) between 1 and 2500),
  created_at timestamptz not null default now()
);
create index if not exists resource_messages_resource_created_idx on public.resource_messages(resource_id,created_at);
create index if not exists resource_messages_sender_created_idx on public.resource_messages(sender_id,created_at desc);

alter table public.resource_messages enable row level security;
revoke all on public.resource_messages from anon, authenticated;
grant select on public.resource_messages to authenticated;

drop policy if exists "resource_messages_read" on public.resource_messages;
create policy "resource_messages_read" on public.resource_messages
 for select to authenticated using (
   public.is_admin() or
   (student_id=(select auth.uid()) and public.is_active_student() and
     exists (select 1 from public.resources r
       where r.id=resource_id and r.student_id=(select auth.uid())))
 );

-- Pas de grants INSERT/UPDATE/DELETE au navigateur pour les messages.
-- Ne PAS rendre public le bucket eleves-documents.

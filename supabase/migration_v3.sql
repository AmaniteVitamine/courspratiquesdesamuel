-- Maths pratiques de Samuel / Espace eleves V3
-- A executer APRES migration_v2.sql. Peut etre relance sans effacer les messages.
-- L'absence de valeur signifie que le message eleve est encore non lu dans l'admin.
alter table public.resource_messages
  add column if not exists admin_read_at timestamptz;

create index if not exists resource_messages_admin_unread_idx
  on public.resource_messages (created_at desc)
  where sender_role = 'student' and admin_read_at is null;

-- Les navigateurs conservent uniquement la lecture autorisee par le RLS de V2.
-- Mise a jour, suppression et marquage lus/non lus : Edge Function manage-messages
-- apres verification du jeton et du role admin. Aucun grant supplementaire ici.

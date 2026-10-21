-- Maths pratiques de Samuel — migration V6 non destructive.
-- À exécuter APRÈS migration_v4.sql, une fois par projet.
-- Préserve utilisateurs, documents, PDFs, messages et sources LaTeX existantes.
-- Réduit la latence d'envoi des questions et conserve les versions des sources LaTeX.

-- 1. Historique privé des sources. La table n'est pas accessible aux élèves.
create table if not exists public.resource_file_source_history (
  id uuid primary key default gen_random_uuid(),
  file_path text not null,
  resource_id uuid not null references public.resources(id) on delete cascade,
  latex_source text not null check (char_length(latex_source) between 1 and 500000),
  saved_at timestamptz not null default now()
);
create index if not exists resource_file_source_history_file_idx
  on public.resource_file_source_history(file_path, saved_at desc);

alter table public.resource_file_source_history enable row level security;
revoke all on public.resource_file_source_history from public, anon, authenticated;
grant select on public.resource_file_source_history to authenticated;

drop policy if exists "latex_history_admin_only" on public.resource_file_source_history;
create policy "latex_history_admin_only"
  on public.resource_file_source_history for select to authenticated
  using (public.is_admin());

-- Copier une fois les sources déjà sauvegardées avant d'activer l'historique.
insert into public.resource_file_source_history (file_path, resource_id, latex_source, saved_at)
select s.file_path, s.resource_id, s.latex_source, s.updated_at
from public.resource_file_sources s
where char_length(btrim(s.latex_source)) > 0
  and not exists (
    select 1 from public.resource_file_source_history h where h.file_path=s.file_path
  );

create or replace function public.archive_resource_file_source()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' then
    insert into public.resource_file_source_history(file_path,resource_id,latex_source)
    values(new.file_path,new.resource_id,new.latex_source);
  elsif new.latex_source is distinct from old.latex_source then
    insert into public.resource_file_source_history(file_path,resource_id,latex_source)
    values(new.file_path,new.resource_id,new.latex_source);
  end if;
  -- Retenir les 20 dernières versions par chemin pour maîtriser l'espace occupé.
  delete from public.resource_file_source_history h
    where h.id in (
      select h2.id from public.resource_file_source_history h2
      where h2.file_path=new.file_path
      order by h2.saved_at desc,h2.id desc offset 20
    );
  return new;
end;
$$;
revoke all on function public.archive_resource_file_source() from public;
drop trigger if exists resource_file_source_history_trigger on public.resource_file_sources;
create trigger resource_file_source_history_trigger
  after insert or update of latex_source on public.resource_file_sources
  for each row execute function public.archive_resource_file_source();

-- 2. Envoi de message sans démarrer une Edge Function à chaque question.
-- Les élèves n'ont toujours aucun droit INSERT direct sur resource_messages.
-- La fonction vérifie explicitement auth.uid(), le rôle, les droits sur la ressource
-- et les limites anti-spam avant d'insérer avec des privilèges contrôlés.
create or replace function public.send_resource_message_fast(
  p_resource_id uuid, p_body text
) returns table (id uuid, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_role text;
  v_student uuid;
  v_body text;
  v_count integer;
  v_last timestamptz;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Connexion requise.';
  end if;

  v_body := btrim(coalesce(p_body,''));
  if char_length(v_body) < 1 or char_length(v_body) > 2500 then
    raise exception 'Écris un message de 2 500 caractères maximum.';
  end if;

  select p.role into v_role
  from public.profiles p
  where p.id=v_uid and p.active=true;
  if v_role is null or v_role not in ('admin','student') then
    raise exception 'Compte inactif ou non autorisé.';
  end if;

  select r.student_id into v_student
  from public.resources r where r.id=p_resource_id;
  if v_student is null then
    raise exception 'Document introuvable.';
  end if;
  if v_role='student' and v_student<>v_uid then
    raise exception 'Accès interdit à cette discussion.';
  end if;

  if v_role='student' then
    -- Sérialise les envois d'un élève contre deux clics simultanés.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text,17));

    select m.created_at into v_last from public.resource_messages m
    where m.sender_id=v_uid order by m.created_at desc limit 1;
    if v_last is not null and v_last > now() - interval '8 seconds' then
      raise exception 'Attends quelques secondes avant d’envoyer un autre message.';
    end if;
    select count(*) into v_count from public.resource_messages m
    where m.sender_id=v_uid and m.created_at>=now()-interval '1 hour';
    if v_count>=25 then
      raise exception 'Trop de messages envoyés. Réessaie plus tard.';
    end if;
  end if;

  return query
    insert into public.resource_messages as m
      (resource_id, student_id, sender_id, sender_role, body)
    values (p_resource_id, v_student, v_uid, v_role, v_body)
    returning m.id, m.created_at;
end;
$$;
revoke all on function public.send_resource_message_fast(uuid,text) from public,anon;
grant execute on function public.send_resource_message_fast(uuid,text) to authenticated;

-- Vérifications possibles :
-- select count(*) from public.resource_file_sources;
-- select count(*) from public.resource_file_source_history;
-- select routine_name from information_schema.routines
--   where routine_schema='public' and routine_name='send_resource_message_fast';

-- Права владельца (админа): удалить любое сообщение и удалить участника из чата.
-- Выполнять после 202611160004_reliability.sql.
begin;

-- Сообщения удалённого участника остаются в истории (имя хранится в самом сообщении), но теряют ссылку на автора.
alter table public.mayak_messages alter column user_id drop not null;
alter table public.mayak_messages drop constraint if exists mayak_messages_user_id_fkey;
alter table public.mayak_messages add constraint mayak_messages_user_id_fkey
 foreign key (user_id) references public.mayak_members(id) on delete set null;

-- Удалить сообщение может автор или владелец.
create or replace function mayak_private.remove(p_id bigint) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_uid uuid := auth.uid();
begin
 update public.mayak_messages set text='',deleted=now(),edited=null,reactions='{}'::jsonb
  where id=p_id and deleted is null
   and (user_id=v_uid or exists(select 1 from public.mayak_members where id=v_uid and owner))
  returning * into v_msg;
 if not found then raise exception 'Удалить можно только своё сообщение.' using errcode='42501'; end if;
 return v_msg;
end;
$$;

-- Удалить участника: он сразу теряет доступ к чату, его подписки на уведомления и ссылки сброса пароля стираются.
-- Вернуть можно новым приглашением. Владельца удалить нельзя.
create function mayak_private.kick(p_user uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
 perform 1 from public.mayak_members where id=auth.uid() and owner;
 if not found then raise exception 'Удалять участников может только владелец.' using errcode='42501'; end if;
 if exists(select 1 from public.mayak_members where id=p_user and owner) then raise exception 'Владельца удалить нельзя.'; end if;
 delete from public.mayak_members where id=p_user;
 if not found then raise exception 'Участник не найден.'; end if;
 -- Учётную запись тоже убираем, чтобы имя освободилось и старый пароль перестал действовать.
 -- Если у базы нет на это прав, участник всё равно уже без доступа.
 begin
  delete from auth.users where id=p_user;
 exception when others then null;
 end;
end;
$$;
create function public.mayak_kick(p_user uuid) returns void language sql security invoker set search_path='' as $$ select mayak_private.kick(p_user); $$;
revoke all on function mayak_private.kick(uuid),public.mayak_kick(uuid) from public,anon;
grant execute on function mayak_private.kick(uuid),public.mayak_kick(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;

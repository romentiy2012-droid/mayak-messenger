-- Ответы, реакции, изменение и удаление сообщений, «прочитано», «печатает», счётчик непрочитанных.
-- Выполнять после 202611160002_push.sql. Старые версии приложения продолжают работать.
begin;

alter table public.mayak_messages
 add column if not exists reply_to bigint references public.mayak_messages(id) on delete set null,
 add column if not exists edited timestamptz,
 add column if not exists deleted timestamptz,
 add column if not exists reactions jsonb not null default '{}'::jsonb,
 add column if not exists rev bigint;
-- У удалённого сообщения текст пустой.
alter table public.mayak_messages drop constraint if exists mayak_messages_text_check;
alter table public.mayak_messages add constraint mayak_messages_text_check
 check (deleted is not null or char_length(btrim(text)) between 1 and 2000);

-- rev растёт при каждом изменении сообщения: по нему приложение узнаёт, что нужно обновить.
create sequence mayak_private.rev;
update public.mayak_messages set rev=id where rev is null;
select setval('mayak_private.rev', greatest((select coalesce(max(id),0) from public.mayak_messages),1));
alter table public.mayak_messages alter column rev set default nextval('mayak_private.rev');
alter table public.mayak_messages alter column rev set not null;
create index mayak_messages_rev on public.mayak_messages(rev);
create function mayak_private.bump_rev() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 new.rev := nextval('mayak_private.rev');
 return new;
end;
$$;
revoke all on function mayak_private.bump_rev() from public,anon,authenticated;
-- Отметка об отправке push (pushed) видимых изменений не несёт и rev не трогает.
create trigger mayak_messages_rev before update on public.mayak_messages for each row
 when (old.text is distinct from new.text or old.deleted is distinct from new.deleted
  or old.edited is distinct from new.edited or old.reactions is distinct from new.reactions)
 execute function mayak_private.bump_rev();

alter table public.mayak_members
 add column if not exists last_read bigint not null default 0,
 add column if not exists typing timestamptz;
-- Всё, что написано до обновления, считается прочитанным.
update public.mayak_members set last_read=(select coalesce(max(id),0) from public.mayak_messages);
-- Новый участник тоже начинает без непрочитанных: история до его прихода не считается.
create function mayak_private.member_start() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 new.last_read := (select coalesce(max(id),0) from public.mayak_messages);
 return new;
end;
$$;
revoke all on function mayak_private.member_start() from public,anon,authenticated;
create trigger mayak_members_start before insert on public.mayak_members for each row execute function mayak_private.member_start();

create function mayak_private.post(p_text text, p_nonce text, p_reply bigint) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_member public.mayak_members; v_msg public.mayak_messages; v_reply bigint;
begin
 select * into v_member from public.mayak_members where id=auth.uid() for update;
 if not found then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 select * into v_msg from public.mayak_messages where user_id=v_member.id and nonce=p_nonce;
 if found then return v_msg; end if;
 if p_text is null or char_length(btrim(p_text)) not between 1 and 2000 then raise exception 'Сообщение должно содержать от 1 до 2000 символов.'; end if;
 if p_nonce is null or char_length(p_nonce) not between 1 and 100 then raise exception 'Неверный идентификатор сообщения.'; end if;
 if exists(select 1 from public.mayak_messages where user_id=v_member.id and created > clock_timestamp()-interval '500 milliseconds') then raise exception 'Слишком быстро. Повторите через секунду.'; end if;
 select id into v_reply from public.mayak_messages where id=p_reply and deleted is null;
 insert into public.mayak_messages(user_id,name,text,nonce,reply_to) values(v_member.id,v_member.name,btrim(p_text),p_nonce,v_reply) returning * into v_msg;
 -- Отправитель прочитал всё до своего сообщения и больше не печатает.
 update public.mayak_members set last_read=v_msg.id,typing=null where id=v_member.id;
 return v_msg;
end;
$$;
-- Прежний вызов без ответа остаётся для старых версий приложения.
create or replace function mayak_private.send(p_text text, p_nonce text) returns public.mayak_messages language sql security definer set search_path = '' as $$
 select mayak_private.post(p_text,p_nonce,null);
$$;
create function mayak_private.edit(p_id bigint, p_text text) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages;
begin
 if p_text is null or char_length(btrim(p_text)) not between 1 and 2000 then raise exception 'Сообщение должно содержать от 1 до 2000 символов.'; end if;
 update public.mayak_messages set text=btrim(p_text),edited=now()
  where id=p_id and user_id=auth.uid() and deleted is null returning * into v_msg;
 if not found then raise exception 'Изменить можно только своё сообщение.' using errcode='42501'; end if;
 return v_msg;
end;
$$;
create function mayak_private.remove(p_id bigint) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages;
begin
 update public.mayak_messages set text='',deleted=now(),edited=null,reactions='{}'::jsonb
  where id=p_id and user_id=auth.uid() and deleted is null returning * into v_msg;
 if not found then raise exception 'Удалить можно только своё сообщение.' using errcode='42501'; end if;
 return v_msg;
end;
$$;
-- p_emoji = null снимает реакцию. У каждого участника одна реакция на сообщение.
create function mayak_private.react(p_id bigint, p_emoji text) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_uid uuid := auth.uid();
begin
 if not exists(select 1 from public.mayak_members where id=v_uid) then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 if p_emoji is not null and char_length(p_emoji) not between 1 and 16 then raise exception 'Неверная реакция.'; end if;
 update public.mayak_messages set reactions=case when p_emoji is null then reactions - v_uid::text
   else reactions || jsonb_build_object(v_uid::text,p_emoji) end
  where id=p_id and deleted is null returning * into v_msg;
 if not found then raise exception 'Сообщение не найдено.'; end if;
 return v_msg;
end;
$$;
create function mayak_private.read(p_id bigint) returns void language sql security definer set search_path = '' as $$
 update public.mayak_members set last_read=least(p_id,(select coalesce(max(id),0) from public.mayak_messages))
  where id=auth.uid() and last_read < least(p_id,(select coalesce(max(id),0) from public.mayak_messages));
$$;
create function mayak_private.typing(p_on boolean) returns void language sql security definer set search_path = '' as $$
 update public.mayak_members set typing=case when p_on then now() end where id=auth.uid();
$$;

create function public.mayak_post(p_text text,p_nonce text,p_reply bigint) returns public.mayak_messages language sql security invoker set search_path='' as $$ select mayak_private.post(p_text,p_nonce,p_reply); $$;
create function public.mayak_edit(p_id bigint,p_text text) returns public.mayak_messages language sql security invoker set search_path='' as $$ select mayak_private.edit(p_id,p_text); $$;
create function public.mayak_delete(p_id bigint) returns public.mayak_messages language sql security invoker set search_path='' as $$ select mayak_private.remove(p_id); $$;
create function public.mayak_react(p_id bigint,p_emoji text) returns public.mayak_messages language sql security invoker set search_path='' as $$ select mayak_private.react(p_id,p_emoji); $$;
create function public.mayak_read(p_id bigint) returns void language sql security invoker set search_path='' as $$ select mayak_private.read(p_id); $$;
create function public.mayak_typing(p_on boolean) returns void language sql security invoker set search_path='' as $$ select mayak_private.typing(p_on); $$;
revoke all on function mayak_private.post(text,text,bigint),mayak_private.edit(bigint,text),mayak_private.remove(bigint),mayak_private.react(bigint,text),mayak_private.read(bigint),mayak_private.typing(boolean) from public,anon;
grant execute on function mayak_private.post(text,text,bigint),mayak_private.edit(bigint,text),mayak_private.remove(bigint),mayak_private.react(bigint,text),mayak_private.read(bigint),mayak_private.typing(boolean) to authenticated;
revoke all on function public.mayak_post(text,text,bigint),public.mayak_edit(bigint,text),public.mayak_delete(bigint),public.mayak_react(bigint,text),public.mayak_read(bigint),public.mayak_typing(boolean) from public,anon;
grant execute on function public.mayak_post(text,text,bigint),public.mayak_edit(bigint,text),public.mayak_delete(bigint),public.mayak_react(bigint,text),public.mayak_read(bigint),public.mayak_typing(boolean) to authenticated;

-- Push: вместе с подпиской выдаётся число непрочитанных получателя — для значка на иконке.
create or replace function public.mayak_push_claim(p_id bigint) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_key text;
begin
 update public.mayak_messages set pushed=now()
  where id=p_id and pushed is null and deleted is null and created > now()-interval '5 minutes' returning * into v_msg;
 if not found then return null; end if;
 begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name='mayak_vapid_private_key';
 exception when others then v_key := null;
 end;
 return jsonb_build_object('vapid',v_key,'id',v_msg.id,'title',v_msg.name,'body',left(v_msg.text,200),
  'subscriptions',coalesce((select jsonb_agg(jsonb_build_object('endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth,
    'badge',(select count(*) from public.mayak_messages x where x.id>m.last_read and x.user_id<>m.id and x.deleted is null)))
   from mayak_private.push_subscriptions s join public.mayak_members m on m.id=s.user_id
   where s.user_id<>v_msg.user_id),'[]'::jsonb));
end;
$$;

-- «Прочитано» и «печатает» приходят в приложение сразу, как и сообщения.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime')
  and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='mayak_members') then
  alter publication supabase_realtime add table public.mayak_members;
 end if;
end $$;
notify pgrst, 'reload schema';
commit;

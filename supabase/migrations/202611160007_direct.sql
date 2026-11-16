-- Личные чаты один на один, отметка «прослушано» у голосовых.
-- Выполнять после 202611160006_media.sql. Старые вызовы (mayak_post, mayak_attach, mayak_read, mayak_typing) работают как раньше — для общего чата.
begin;

-- У личного сообщения заполнены оба участника (меньший id — в peer_a); у общего оба пусты.
-- Ссылок на участников здесь нет намеренно: при удалении участника личная переписка не должна ни пропасть, ни стать общей.
alter table public.mayak_messages
 add column if not exists peer_a uuid,
 add column if not exists peer_b uuid,
 add column if not exists heard jsonb not null default '[]'::jsonb;
alter table public.mayak_messages add constraint mayak_messages_peer_check
 check ((peer_a is null and peer_b is null) or (peer_a is not null and peer_b is not null and peer_a < peer_b));
create index if not exists mayak_messages_direct on public.mayak_messages(peer_a,peer_b,id) where peer_a is not null;

-- Личное сообщение видят только двое его участников.
alter policy messages_read on public.mayak_messages
 using ((select mayak_private.is_member()) and (peer_a is null or (select auth.uid()) in (peer_a,peer_b)));

-- Состояние личного чата со стороны одного участника: до какого сообщения он прочитал и печатает ли сейчас.
create table public.mayak_reads (
 user_id uuid not null references public.mayak_members(id) on delete cascade,
 peer uuid not null,
 last_read bigint not null default 0,
 typing timestamptz,
 primary key (user_id, peer)
);
alter table public.mayak_reads enable row level security;
revoke all on public.mayak_reads from public, anon, authenticated;
grant select on public.mayak_reads to authenticated;
create policy reads_read on public.mayak_reads for select to authenticated
 using ((select auth.uid()) in (user_id, peer));

-- Отправка текста: p_peer пуст — общий чат, иначе личный чат с этим участником.
create function mayak_private.post_to(p_peer uuid, p_text text, p_nonce text, p_reply bigint) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_member public.mayak_members; v_msg public.mayak_messages; v_reply bigint; v_a uuid; v_b uuid;
begin
 select * into v_member from public.mayak_members where id=auth.uid() for update;
 if not found then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 select * into v_msg from public.mayak_messages where user_id=v_member.id and nonce=p_nonce;
 if found then return v_msg; end if;
 if p_text is null or char_length(btrim(p_text)) not between 1 and 2000 then raise exception 'Сообщение должно содержать от 1 до 2000 символов.'; end if;
 if p_nonce is null or char_length(p_nonce) not between 1 and 100 then raise exception 'Неверный идентификатор сообщения.'; end if;
 if p_peer is not null then
  if p_peer=v_member.id or not exists(select 1 from public.mayak_members where id=p_peer) then raise exception 'Участник не найден.'; end if;
  v_a := least(v_member.id,p_peer); v_b := greatest(v_member.id,p_peer);
 end if;
 if exists(select 1 from public.mayak_messages where user_id=v_member.id and created > clock_timestamp()-interval '500 milliseconds') then raise exception 'Слишком быстро. Повторите через секунду.'; end if;
 -- Отвечать можно только на сообщение из того же чата.
 select id into v_reply from public.mayak_messages where id=p_reply and deleted is null and peer_a is not distinct from v_a and peer_b is not distinct from v_b;
 insert into public.mayak_messages(user_id,name,text,nonce,reply_to,peer_a,peer_b) values(v_member.id,v_member.name,btrim(p_text),p_nonce,v_reply,v_a,v_b) returning * into v_msg;
 if p_peer is null then
  update public.mayak_members set last_read=v_msg.id,typing=null where id=v_member.id;
 else
  insert into public.mayak_reads(user_id,peer,last_read,typing) values(v_member.id,p_peer,v_msg.id,null)
   on conflict (user_id,peer) do update set last_read=excluded.last_read,typing=null;
 end if;
 return v_msg;
end;
$$;
create function mayak_private.attach_to(p_peer uuid, p_kind text, p_file text, p_meta jsonb, p_text text, p_nonce text, p_reply bigint) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_member public.mayak_members; v_msg public.mayak_messages; v_reply bigint; v_caption text := btrim(coalesce(p_text,'')); v_meta jsonb; v_a uuid; v_b uuid;
begin
 select * into v_member from public.mayak_members where id=auth.uid() for update;
 if not found then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 select * into v_msg from public.mayak_messages where user_id=v_member.id and nonce=p_nonce;
 if found then return v_msg; end if;
 if p_kind is null or p_kind not in ('photo','voice') then raise exception 'Неверный вид вложения.'; end if;
 if p_nonce is null or char_length(p_nonce) not between 1 and 100 then raise exception 'Неверный идентификатор сообщения.'; end if;
 if p_file is null or p_file !~ ('^' || v_member.id::text || '/[A-Za-z0-9_-]{8,80}\.[a-z0-9]{2,5}$') then raise exception 'Неверный файл вложения.'; end if;
 if exists(select 1 from public.mayak_messages where file=p_file) then raise exception 'Этот файл уже отправлен.'; end if;
 if char_length(v_caption) > 2000 then raise exception 'Подпись должна быть не длиннее 2000 символов.'; end if;
 if p_kind='voice' then v_caption := ''; end if;
 if p_peer is not null then
  if p_peer=v_member.id or not exists(select 1 from public.mayak_members where id=p_peer) then raise exception 'Участник не найден.'; end if;
  v_a := least(v_member.id,p_peer); v_b := greatest(v_member.id,p_peer);
 end if;
 if exists(select 1 from public.mayak_messages where user_id=v_member.id and created > clock_timestamp()-interval '500 milliseconds') then raise exception 'Слишком быстро. Повторите через секунду.'; end if;
 v_meta := jsonb_build_object('caption', v_caption<>'',
  'w', least(greatest(coalesce((p_meta->>'w')::int,0),0),10000), 'h', least(greatest(coalesce((p_meta->>'h')::int,0),0),10000),
  'duration', least(greatest(coalesce((p_meta->>'duration')::numeric,0),0),3600),
  'size', least(greatest(coalesce((p_meta->>'size')::bigint,0),0),104857600),
  'mime', left(coalesce(p_meta->>'mime',''),60));
 select id into v_reply from public.mayak_messages where id=p_reply and deleted is null and peer_a is not distinct from v_a and peer_b is not distinct from v_b;
 insert into public.mayak_messages(user_id,name,text,nonce,reply_to,kind,file,file_meta,peer_a,peer_b)
  values(v_member.id,v_member.name,
   case when v_caption<>'' then v_caption when p_kind='photo' then '📷 Фото' else '🎤 Голосовое сообщение' end,
   p_nonce,v_reply,p_kind,p_file,v_meta,v_a,v_b) returning * into v_msg;
 if p_peer is null then
  update public.mayak_members set last_read=v_msg.id,typing=null where id=v_member.id;
 else
  insert into public.mayak_reads(user_id,peer,last_read,typing) values(v_member.id,p_peer,v_msg.id,null)
   on conflict (user_id,peer) do update set last_read=excluded.last_read,typing=null;
 end if;
 return v_msg;
end;
$$;
-- Прежние вызовы — то же самое для общего чата.
create or replace function mayak_private.post(p_text text, p_nonce text, p_reply bigint) returns public.mayak_messages language sql security definer set search_path = '' as $$
 select mayak_private.post_to(null,p_text,p_nonce,p_reply);
$$;
create or replace function mayak_private.attach(p_kind text, p_file text, p_meta jsonb, p_text text, p_nonce text, p_reply bigint) returns public.mayak_messages language sql security definer set search_path = '' as $$
 select mayak_private.attach_to(null,p_kind,p_file,p_meta,p_text,p_nonce,p_reply);
$$;

-- «Прочитано» и «печатает» для личного чата (p_peer пуст — общий чат, как раньше).
create function mayak_private.read_to(p_peer uuid, p_id bigint) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_last bigint;
begin
 if p_peer is null then perform mayak_private.read(p_id); return; end if;
 if not exists(select 1 from public.mayak_members where id=v_uid) then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 select least(p_id,coalesce(max(id),0)) into v_last from public.mayak_messages
  where peer_a=least(v_uid,p_peer) and peer_b=greatest(v_uid,p_peer);
 if v_last < 1 then return; end if;
 insert into public.mayak_reads(user_id,peer,last_read) values(v_uid,p_peer,v_last)
  on conflict (user_id,peer) do update set last_read=greatest(public.mayak_reads.last_read,excluded.last_read);
end;
$$;
create function mayak_private.typing_to(p_peer uuid, p_on boolean) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
 if p_peer is null then perform mayak_private.typing(p_on); return; end if;
 if p_peer=v_uid or not exists(select 1 from public.mayak_members where id=v_uid) or not exists(select 1 from public.mayak_members where id=p_peer) then return; end if;
 insert into public.mayak_reads(user_id,peer,typing) values(v_uid,p_peer,case when p_on then now() end)
  on conflict (user_id,peer) do update set typing=excluded.typing;
end;
$$;
-- Отметить голосовое прослушанным. rev двигается вручную, чтобы изменение дошло до автора.
create function mayak_private.heard(p_id bigint) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_uid uuid := auth.uid();
begin
 if not exists(select 1 from public.mayak_members where id=v_uid) then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 update public.mayak_messages set heard=heard || to_jsonb(v_uid::text),rev=nextval('mayak_private.rev')
  where id=p_id and kind='voice' and deleted is null and user_id is distinct from v_uid
   and not heard ? v_uid::text and (peer_a is null or v_uid in (peer_a,peer_b))
  returning * into v_msg;
 if not found then select * into v_msg from public.mayak_messages where id=p_id and (peer_a is null or v_uid in (peer_a,peer_b)); end if;
 return v_msg;
end;
$$;
-- Реакцию можно поставить только на сообщение, которое видишь.
create or replace function mayak_private.react(p_id bigint, p_emoji text) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_uid uuid := auth.uid();
begin
 if not exists(select 1 from public.mayak_members where id=v_uid) then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 if p_emoji is not null and char_length(p_emoji) not between 1 and 16 then raise exception 'Неверная реакция.'; end if;
 update public.mayak_messages set reactions=case when p_emoji is null then reactions - v_uid::text
   else reactions || jsonb_build_object(v_uid::text,p_emoji) end
  where id=p_id and deleted is null and (peer_a is null or v_uid in (peer_a,peer_b)) returning * into v_msg;
 if not found then raise exception 'Сообщение не найдено.'; end if;
 return v_msg;
end;
$$;
-- Владелец удаляет любое сообщение общего чата; в личных чатах — только автор.
create or replace function mayak_private.remove(p_id bigint) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_uid uuid := auth.uid();
begin
 update public.mayak_messages set text='',deleted=now(),edited=null,reactions='{}'::jsonb,file=null,file_meta=null
  where id=p_id and deleted is null
   and (user_id=v_uid or (peer_a is null and exists(select 1 from public.mayak_members where id=v_uid and owner)))
  returning * into v_msg;
 if not found then raise exception 'Удалить можно только своё сообщение.' using errcode='42501'; end if;
 return v_msg;
end;
$$;

create function public.mayak_post_to(p_peer uuid,p_text text,p_nonce text,p_reply bigint) returns public.mayak_messages language sql security invoker set search_path='' as $$ select mayak_private.post_to(p_peer,p_text,p_nonce,p_reply); $$;
create function public.mayak_attach_to(p_peer uuid,p_kind text,p_file text,p_meta jsonb,p_text text,p_nonce text,p_reply bigint) returns public.mayak_messages language sql security invoker set search_path='' as $$ select mayak_private.attach_to(p_peer,p_kind,p_file,p_meta,p_text,p_nonce,p_reply); $$;
create function public.mayak_read_to(p_peer uuid,p_id bigint) returns void language sql security invoker set search_path='' as $$ select mayak_private.read_to(p_peer,p_id); $$;
create function public.mayak_typing_to(p_peer uuid,p_on boolean) returns void language sql security invoker set search_path='' as $$ select mayak_private.typing_to(p_peer,p_on); $$;
create function public.mayak_heard(p_id bigint) returns public.mayak_messages language sql security invoker set search_path='' as $$ select mayak_private.heard(p_id); $$;
revoke all on function mayak_private.post_to(uuid,text,text,bigint),mayak_private.attach_to(uuid,text,text,jsonb,text,text,bigint),mayak_private.read_to(uuid,bigint),mayak_private.typing_to(uuid,boolean),mayak_private.heard(bigint) from public,anon;
grant execute on function mayak_private.post_to(uuid,text,text,bigint),mayak_private.attach_to(uuid,text,text,jsonb,text,text,bigint),mayak_private.read_to(uuid,bigint),mayak_private.typing_to(uuid,boolean),mayak_private.heard(bigint) to authenticated;
revoke all on function public.mayak_post_to(uuid,text,text,bigint),public.mayak_attach_to(uuid,text,text,jsonb,text,text,bigint),public.mayak_read_to(uuid,bigint),public.mayak_typing_to(uuid,boolean),public.mayak_heard(bigint) from public,anon;
grant execute on function public.mayak_post_to(uuid,text,text,bigint),public.mayak_attach_to(uuid,text,text,jsonb,text,text,bigint),public.mayak_read_to(uuid,bigint),public.mayak_typing_to(uuid,boolean),public.mayak_heard(bigint) to authenticated;

-- Push: личное сообщение уходит только собеседнику; значок считает непрочитанное в общем и во всех личных чатах.
create or replace function public.mayak_push_claim(p_id bigint) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_key text; v_subs jsonb;
begin
 update public.mayak_messages set push_at=now(),push_tries=push_tries+1
  where id=p_id and pushed is null and deleted is null and created > now()-interval '15 minutes'
   and push_tries < 6 and (push_at is null or push_at < now()-interval '20 seconds') returning * into v_msg;
 if not found then return null; end if;
 select jsonb_agg(jsonb_build_object('endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth,
   'badge',(select count(*) from public.mayak_messages x where x.deleted is null and x.user_id<>m.id and (
     (x.peer_a is null and x.id>m.last_read)
     or (m.id in (x.peer_a,x.peer_b) and x.id>coalesce((select r.last_read from public.mayak_reads r where r.user_id=m.id and r.peer=x.user_id),0))))))
  into v_subs
  from mayak_private.push_subscriptions s join public.mayak_members m on m.id=s.user_id
  where s.user_id<>v_msg.user_id and (v_msg.peer_a is null or s.user_id in (v_msg.peer_a,v_msg.peer_b))
   and (v_msg.push_pending is null or s.endpoint=any(v_msg.push_pending));
 if v_subs is null then
  update public.mayak_messages set pushed=now(),push_pending=null where id=p_id;
  return null;
 end if;
 begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name='mayak_vapid_private_key';
 exception when others then v_key := null;
 end;
 return jsonb_build_object('vapid',v_key,'id',v_msg.id,
  'title',case when v_msg.peer_a is null then v_msg.name else v_msg.name || ' · лично' end,
  'body',left(v_msg.text,200),'subscriptions',v_subs);
end;
$$;

do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime')
  and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='mayak_reads') then
  alter publication supabase_realtime add table public.mayak_reads;
 end if;
end $$;
notify pgrst, 'reload schema';
commit;

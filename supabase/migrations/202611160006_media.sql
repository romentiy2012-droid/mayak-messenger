-- Фото и голосовые сообщения: файлы лежат в закрытом хранилище Supabase Storage (бакет mayak),
-- в сообщении — вид вложения, путь к файлу и его параметры.
-- Выполнять после 202611160005_admin.sql.
begin;

alter table public.mayak_messages
 add column if not exists kind text not null default 'text',
 add column if not exists file text,
 add column if not exists file_meta jsonb;
alter table public.mayak_messages add constraint mayak_messages_kind_check
 check (kind in ('text','photo','voice') and ((kind='text' and file is null) or kind<>'text'));

-- Сообщение с вложением. Файл уже загружен участником в свою папку хранилища (<его id>/…).
-- У текста всегда есть содержимое: подпись к фото либо «📷 Фото» / «🎤 Голосовое сообщение» —
-- его видят уведомления, цитаты и старые версии приложения. Была ли подпись — в file_meta.caption.
create function mayak_private.attach(p_kind text, p_file text, p_meta jsonb, p_text text, p_nonce text, p_reply bigint) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_member public.mayak_members; v_msg public.mayak_messages; v_reply bigint; v_caption text := btrim(coalesce(p_text,'')); v_meta jsonb;
begin
 select * into v_member from public.mayak_members where id=auth.uid() for update;
 if not found then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 select * into v_msg from public.mayak_messages where user_id=v_member.id and nonce=p_nonce;
 if found then return v_msg; end if;
 if p_kind is null or p_kind not in ('photo','voice') then raise exception 'Неверный вид вложения.'; end if;
 if p_nonce is null or char_length(p_nonce) not between 1 and 100 then raise exception 'Неверный идентификатор сообщения.'; end if;
 -- Только свой файл: путь начинается с id участника, без подкаталогов и переходов вверх.
 if p_file is null or p_file !~ ('^' || v_member.id::text || '/[A-Za-z0-9_-]{8,80}\.[a-z0-9]{2,5}$') then raise exception 'Неверный файл вложения.'; end if;
 if exists(select 1 from public.mayak_messages where file=p_file) then raise exception 'Этот файл уже отправлен.'; end if;
 if char_length(v_caption) > 2000 then raise exception 'Подпись должна быть не длиннее 2000 символов.'; end if;
 if p_kind='voice' then v_caption := ''; end if;
 if exists(select 1 from public.mayak_messages where user_id=v_member.id and created > clock_timestamp()-interval '500 milliseconds') then raise exception 'Слишком быстро. Повторите через секунду.'; end if;
 -- Из параметров берём только известные числа — чужой произвольный JSON в базу не попадает.
 v_meta := jsonb_build_object('caption', v_caption<>'',
  'w', least(greatest(coalesce((p_meta->>'w')::int,0),0),10000), 'h', least(greatest(coalesce((p_meta->>'h')::int,0),0),10000),
  'duration', least(greatest(coalesce((p_meta->>'duration')::numeric,0),0),3600),
  'size', least(greatest(coalesce((p_meta->>'size')::bigint,0),0),104857600),
  'mime', left(coalesce(p_meta->>'mime',''),60));
 select id into v_reply from public.mayak_messages where id=p_reply and deleted is null;
 insert into public.mayak_messages(user_id,name,text,nonce,reply_to,kind,file,file_meta)
  values(v_member.id,v_member.name,
   case when v_caption<>'' then v_caption when p_kind='photo' then '📷 Фото' else '🎤 Голосовое сообщение' end,
   p_nonce,v_reply,p_kind,p_file,v_meta) returning * into v_msg;
 update public.mayak_members set last_read=v_msg.id,typing=null where id=v_member.id;
 return v_msg;
end;
$$;
create function public.mayak_attach(p_kind text,p_file text,p_meta jsonb,p_text text,p_nonce text,p_reply bigint) returns public.mayak_messages language sql security invoker set search_path='' as $$ select mayak_private.attach(p_kind,p_file,p_meta,p_text,p_nonce,p_reply); $$;
revoke all on function mayak_private.attach(text,text,jsonb,text,text,bigint),public.mayak_attach(text,text,jsonb,text,text,bigint) from public,anon;
grant execute on function mayak_private.attach(text,text,jsonb,text,text,bigint),public.mayak_attach(text,text,jsonb,text,text,bigint) to authenticated;

-- Удалённое сообщение теряет и вложение (сам файл из хранилища стирает приложение).
create or replace function mayak_private.remove(p_id bigint) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_uid uuid := auth.uid();
begin
 update public.mayak_messages set text='',deleted=now(),edited=null,reactions='{}'::jsonb,file=null,file_meta=null
  where id=p_id and deleted is null
   and (user_id=v_uid or exists(select 1 from public.mayak_members where id=v_uid and owner))
  returning * into v_msg;
 if not found then raise exception 'Удалить можно только своё сообщение.' using errcode='42501'; end if;
 return v_msg;
end;
$$;
-- Изменять можно только обычный текст: подпись вложения не редактируется.
create or replace function mayak_private.edit(p_id bigint, p_text text) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages;
begin
 if p_text is null or char_length(btrim(p_text)) not between 1 and 2000 then raise exception 'Сообщение должно содержать от 1 до 2000 символов.'; end if;
 update public.mayak_messages set text=btrim(p_text),edited=now()
  where id=p_id and user_id=auth.uid() and deleted is null and kind='text' returning * into v_msg;
 if not found then raise exception 'Изменить можно только своё текстовое сообщение.' using errcode='42501'; end if;
 return v_msg;
end;
$$;

-- Хранилище: закрытый бакет; читать могут участники чата, загружать — каждый только в свою папку,
-- стирать — автор файла или владелец чата. В тестовой базе хранилища нет — блок пропускается.
do $$ begin
 if not exists(select 1 from pg_namespace where nspname='storage') then
  raise notice 'Хранилище Supabase недоступно, бакет и правила не созданы.';
  return;
 end if;
 insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('mayak','mayak',false,8388608,array['image/jpeg','image/webp','image/png','audio/mp4','audio/webm','audio/ogg','audio/aac','audio/mpeg'])
  on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
 if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='mayak_media_read') then
  create policy mayak_media_read on storage.objects for select to authenticated
   using (bucket_id='mayak' and (select mayak_private.is_member()));
 end if;
 if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='mayak_media_upload') then
  create policy mayak_media_upload on storage.objects for insert to authenticated
   with check (bucket_id='mayak' and (select mayak_private.is_member()) and (storage.foldername(name))[1]=(select auth.uid())::text);
 end if;
 if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='mayak_media_delete') then
  create policy mayak_media_delete on storage.objects for delete to authenticated
   using (bucket_id='mayak' and ((storage.foldername(name))[1]=(select auth.uid())::text
    or exists(select 1 from public.mayak_members where id=(select auth.uid()) and owner)));
 end if;
end $$;
notify pgrst, 'reload schema';
commit;

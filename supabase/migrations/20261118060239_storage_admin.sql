-- Inventory is metadata only. Physical deletion belongs exclusively to the Storage API.
begin;
create index mayak_messages_file_idx on public.mayak_messages(file) where file is not null;
create table mayak_private.storage_operations (
 id uuid primary key default gen_random_uuid(), actor uuid not null,
 nonce text not null check(length(nonce) between 1 and 100),
 created timestamptz not null default now(), updated timestamptz not null default now(),
 unique(actor,nonce)
);
create table mayak_private.storage_cleanup_items (
 operation uuid not null references mayak_private.storage_operations(id),
 object_id uuid not null, version text not null, bucket text not null, path text not null,
 bytes bigint, status text not null default 'pending' check(status in ('pending','failed','deleted')),
 error text, created timestamptz not null default now(), updated timestamptz not null default now(),
 primary key(operation,object_id), unique(bucket,path)
);
-- A normal message deletion lets its authorized caller finish the Storage API delete.
-- Binding the grant to the physical object id prevents reuse after a new upload at the same path.
create table mayak_private.media_release_authorizations (
 object_id uuid not null, path text not null, actor uuid not null,
 created timestamptz not null default now(), primary key(object_id,actor)
);
alter table mayak_private.storage_operations enable row level security;
alter table mayak_private.storage_cleanup_items enable row level security;
alter table mayak_private.media_release_authorizations enable row level security;
revoke all on mayak_private.storage_operations,mayak_private.storage_cleanup_items,mayak_private.media_release_authorizations from public,anon,authenticated;

-- Every new reference and every cleanup reservation share this transaction barrier.
-- A committed cleanup item is a permanent tombstone for its immutable object path.
create function mayak_private.storage_lock() returns void language sql volatile security definer set search_path='' as $$
 select pg_advisory_xact_lock(7102371145273120::bigint);
$$;
create function mayak_private.storage_guard_reference() returns trigger language plpgsql security definer set search_path='' as $$
declare v_bucket text; v_path text; v_actor uuid;
begin
 perform mayak_private.storage_lock();
 if tg_table_name='mayak_messages' then
  v_path:=new.file; v_bucket:=case when new.kind='video' then 'mayak-video' else 'mayak' end;
  if tg_op='UPDATE' and old.file is not null and new.file is null and old.deleted is null and new.deleted is not null
    and old.kind in ('photo','voice') then
   v_actor:=auth.uid();
   if v_actor is not null and exists(select 1 from public.mayak_members m where m.id=v_actor and
      (old.user_id=v_actor or (old.peer_a is null and m.owner))) then
    insert into mayak_private.media_release_authorizations(object_id,path,actor)
     select o.id,o.path,v_actor from mayak_private.storage_objects() o where o.bucket='mayak' and o.path=old.file
     on conflict(object_id,actor) do nothing;
   end if;
  end if;
 elsif tg_table_name='mayak_members' then
  v_path:=new.avatar_file; v_bucket:='mayak-avatars';
 else
  if new.state not in ('queued','processing') then return new; end if;
  if exists(select 1 from mayak_private.storage_cleanup_items where
    (bucket='mayak-video-source' and path=new.source) or (bucket='mayak-video' and path=new.output)) then
   raise exception 'Файл уже выбран для очистки. Запишите новое видео.' using errcode='42501';
  end if;
  return new;
 end if;
 if v_path is not null and exists(select 1 from mayak_private.storage_cleanup_items where bucket=v_bucket and path=v_path) then
  raise exception 'Файл уже выбран для очистки. Загрузите его заново.' using errcode='42501';
 end if;
 return new;
end;
$$;
create trigger mayak_messages_storage_guard before insert or update of file,kind on public.mayak_messages
 for each row execute function mayak_private.storage_guard_reference();
create trigger mayak_members_storage_guard before insert or update of avatar_file on public.mayak_members
 for each row execute function mayak_private.storage_guard_reference();
create trigger mayak_video_storage_guard before insert or update of source,output,state on public.mayak_video_jobs
 for each row execute function mayak_private.storage_guard_reference();

create function mayak_private.storage_owner(p_actor uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_actor is null or not exists(select 1 from public.mayak_members where id=p_actor and owner) then
  raise exception 'Управлять хранилищем может только владелец.' using errcode='42501';
 end if;
end;
$$;

-- JSON extraction keeps local test schemas compatible without changing the managed Storage schema.
create function mayak_private.storage_objects() returns table(
 id uuid,version text,bucket text,path text,bytes bigint,created_at timestamptz,mime text
) language plpgsql stable security definer set search_path='' as $$
begin
 if to_regclass('storage.objects') is null then return; end if;
 return query select
  coalesce(nullif(j->>'id','')::uuid,md5((j->>'bucket_id')||'/'||(j->>'name'))::uuid),
  md5(coalesce(j->>'id','')||'|'||coalesce(j->>'version','')||'|'||coalesce(j->>'created_at','')||'|'||coalesce(j->>'updated_at','')||'|'||coalesce((j->'metadata')::text,'')),
  j->>'bucket_id',j->>'name',
  case when j->'metadata'->>'size' ~ '^[0-9]{1,18}$' then (j->'metadata'->>'size')::bigint else null end,
  coalesce(nullif(j->>'created_at','')::timestamptz,nullif(j->>'updated_at','')::timestamptz,now()),
  coalesce(j->'metadata'->>'mimetype','')
 from (select to_jsonb(o) j from storage.objects o) x;
end;
$$;
create function mayak_private.storage_inventory() returns table(
 id uuid,version text,bucket text,path text,kind text,bytes bigint,created_at timestamptz,
 scope text,can_delete boolean,reason text,label text
) language plpgsql stable security definer set search_path='' as $$
begin
 return query with objects as (
  select o.*,case
   when o.bucket='mayak-avatars' then 'avatar'
   when o.bucket='mayak-video-source' then 'source'
   when o.bucket='mayak-video' then 'video'
   when o.bucket='mayak' and (o.mime like 'image/%' or lower(o.path) ~ '\.(jpg|jpeg|png|webp)$') then 'photo'
   when o.bucket='mayak' and (o.mime like 'audio/%' or lower(o.path) ~ '\.(mp4|webm|ogg|aac|mp3|m4a)$') then 'voice'
   else 'other' end object_kind,
   exists(select 1 from public.mayak_members m where o.bucket='mayak-avatars' and m.avatar_file=o.path) used_avatar,
   exists(select 1 from public.mayak_messages m where m.file=o.path and m.deleted is null
    and ((o.bucket='mayak-video' and m.kind='video') or (o.bucket='mayak' and m.kind in ('photo','voice'))) and m.peer_a is null) in_main,
   exists(select 1 from public.mayak_messages m where m.file=o.path and m.deleted is null
    and ((o.bucket='mayak-video' and m.kind='video') or (o.bucket='mayak' and m.kind in ('photo','voice'))) and m.peer_a is not null) in_direct,
   exists(select 1 from public.mayak_video_jobs j where
    ((o.bucket='mayak-video-source' and j.source=o.path) or (o.bucket='mayak-video' and
      (j.output=o.path or o.path like j.user_id::text||'/'||j.id::text||'_%')))
    and (j.state in ('queued','processing') or (j.state in ('failed','cancelled') and j.updated>now()-interval '24 hours'))) busy_video,
   exists(select 1 from mayak_private.storage_cleanup_items c where c.bucket=o.bucket and c.path=o.path) cleaning,
   coalesce((select string_agg(m.id::text||'/'||m.kind||'/'||coalesce(m.peer_a::text,'')||'/'||coalesce(m.peer_b::text,'')||'/'||coalesce(m.deleted::text,''),',' order by m.id)
     from public.mayak_messages m where m.file=o.path and ((o.bucket='mayak-video' and m.kind='video') or (o.bucket='mayak' and m.kind in ('photo','voice')))),'')
    ||coalesce((select string_agg(m.id::text,',' order by m.id) from public.mayak_members m where o.bucket='mayak-avatars' and m.avatar_file=o.path),'')
    ||coalesce((select string_agg(j.id::text||'/'||j.state||'/'||j.updated::text||'/'||coalesce(j.ticket::text,''),',' order by j.id)
      from public.mayak_video_jobs j where (o.bucket='mayak-video-source' and j.source=o.path) or
       (o.bucket='mayak-video' and (j.output=o.path or o.path like j.user_id::text||'/'||j.id::text||'_%'))),'') ref_signature
  from mayak_private.storage_objects() o
 ), classified as (
  select o.*,case when in_main or used_avatar then 'main' when in_direct then 'direct' else 'unused' end object_scope,
   case when o.bucket not in ('mayak','mayak-video','mayak-video-source','mayak-avatars') then 'Неизвестный бакет: очистка защищена.'
    when used_avatar then 'Используется в профиле.' when busy_video then 'Видео обрабатывается или доступно для повтора.'
    when cleaning then 'Уже выбрано для очистки.'
    when not in_main and not in_direct and o.created_at>now()-interval '24 hours' then 'Новая загрузка: защищена первые 24 часа.'
    else null end blocked
  from objects o
 ) select c.id,md5(c.version||'|'||c.ref_signature||'|'||c.object_scope||'|'||coalesce(c.blocked,'')),c.bucket,c.path,c.object_kind,c.bytes,c.created_at,c.object_scope,c.blocked is null,c.blocked,
  case c.object_kind when 'photo' then 'Фото' when 'voice' then 'Голосовое' when 'video' then 'Видеокружочек'
   when 'source' then 'Исходная запись' when 'avatar' then 'Фото профиля' else 'Другой файл' end
  ||case c.object_scope when 'direct' then ' · личный чат' when 'main' then ' · используется' else ' · без сообщения' end
 from classified c;
end;
$$;
create function public.mayak_storage_overview(p_actor uuid,p_filter text default 'all',p_offset integer default 0)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
 perform mayak_private.storage_owner(p_actor);
 if p_filter not in ('all','photo','voice','video','source','avatar','unused','other') or p_filter is null or p_offset<0 or p_offset>1000000 then
  raise exception 'Неверный фильтр хранилища.';
 end if;
 with all_files as materialized (select * from mayak_private.storage_inventory()),
 filtered as (select * from all_files where p_filter='all' or kind=p_filter or (p_filter='unused' and scope='unused')),
 page as (select * from filtered order by bytes desc nulls last,id limit 50 offset p_offset),
 groups as (select kind category,coalesce(sum(bytes),0) bytes,count(*) count from all_files group by kind)
 select jsonb_build_object('observed_at',now(),'storage',jsonb_build_object(
  'used_bytes',(select coalesce(sum(bytes),0) from all_files),'objects_count',(select count(*) from all_files),
  'unknown_size_count',(select count(*) from all_files where bytes is null),
  'breakdown',coalesce((select jsonb_agg(to_jsonb(g) order by category) from groups g),'[]'::jsonb)),
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'version',p.version,'kind',p.kind,'bytes',p.bytes,
    'created_at',p.created_at,'label',p.label,'scope',p.scope,'can_delete',p.can_delete,'reason',p.reason) order by p.bytes desc nulls last,p.id) from page p),'[]'::jsonb),
  'has_more',(select count(*)>p_offset+50 from filtered),'total_count',(select count(*) from filtered),'offset',p_offset,
  'pending_operation',(select jsonb_build_object('id',o.id,'nonce',o.nonce,'items',
    (select jsonb_agg(jsonb_build_object('id',c.object_id,'version',c.version,'bytes',c.bytes,'status',c.status) order by c.object_id)
     from mayak_private.storage_cleanup_items c where c.operation=o.id))
   from mayak_private.storage_operations o where o.actor=p_actor and exists(
    select 1 from mayak_private.storage_cleanup_items c where c.operation=o.id and c.status<>'deleted')
   order by o.created,o.id limit 1))
 into v_result;
 return v_result;
end;
$$;
create function mayak_private.storage_operation(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',o.id,'items',coalesce((select jsonb_agg(jsonb_build_object(
  'id',c.object_id,'bucket',c.bucket,'path',c.path,'status',c.status,'version',c.version,'bytes',c.bytes,'error',c.error)
  order by c.object_id) from mayak_private.storage_cleanup_items c where c.operation=o.id),'[]'::jsonb))
 from mayak_private.storage_operations o where o.id=p_id;
$$;
create function public.mayak_storage_prepare(p_actor uuid,p_items jsonb,p_nonce text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_operation uuid; v_item jsonb; v_file record; v_plan jsonb:='[]'::jsonb;
begin
 perform mayak_private.storage_owner(p_actor); perform mayak_private.storage_lock();
 if p_nonce is null or length(p_nonce) not between 1 and 100 then raise exception 'Неверный номер очистки.'; end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then
  raise exception 'Выберите от 1 до 20 файлов.';
 end if;
 if (select count(distinct x->>'id') from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) then raise exception 'Файл выбран дважды.'; end if;
 select id into v_operation from mayak_private.storage_operations where actor=p_actor and nonce=p_nonce;
 if found then
  if (select count(*) from mayak_private.storage_cleanup_items where operation=v_operation)<>jsonb_array_length(p_items)
    or exists(select 1 from jsonb_array_elements(p_items) x where not exists(
     select 1 from mayak_private.storage_cleanup_items c where c.operation=v_operation and c.object_id=(x->>'id')::uuid and c.version=x->>'version')) then
   raise exception 'Номер очистки уже использован для другого набора файлов.';
  end if;
  update mayak_private.storage_cleanup_items set status='pending',error=null,updated=now() where operation=v_operation and status='failed';
  return mayak_private.storage_operation(v_operation);
 end if;
 insert into mayak_private.storage_operations(actor,nonce) values(p_actor,p_nonce) returning id into v_operation;
 for v_item in select * from jsonb_array_elements(p_items) loop
  select * into v_file from mayak_private.storage_inventory() where id=(v_item->>'id')::uuid;
  if not found then raise exception 'Файл больше не существует. Обновите список.'; end if;
  if v_item->>'version' is distinct from v_file.version then raise exception 'Файл изменился. Обновите список.'; end if;
  if not v_file.can_delete then raise exception '%',v_file.reason; end if;
  v_plan:=v_plan||jsonb_build_array(to_jsonb(v_file));
 end loop;
 -- Validate the whole snapshot before any mutation: two selected paths can belong to one failed job.
 for v_file in select * from jsonb_to_recordset(v_plan) as x(id uuid,version text,bucket text,path text,bytes bigint) loop
  insert into mayak_private.storage_cleanup_items(operation,object_id,version,bucket,path,bytes)
   values(v_operation,v_file.id,v_file.version,v_file.bucket,v_file.path,v_file.bytes);
  -- Only old failed jobs may be invalidated; queued/processing/recent failures are protected above.
  update public.mayak_video_jobs j set state='cancelled',ticket=null,error='Запись удалена при очистке хранилища.',updated=now()
   where j.state='failed' and j.updated<=now()-interval '24 hours' and
    ((v_file.bucket='mayak-video-source' and j.source=v_file.path) or (v_file.bucket='mayak-video' and
     (j.output=v_file.path or v_file.path like j.user_id::text||'/'||j.id::text||'_%')));
  -- Keep captions, text, reactions, replies and the parent row. Only the attachment disappears.
  update public.mayak_messages m set file=null,file_meta=coalesce(m.file_meta,'{}'::jsonb)||jsonb_build_object('removed',true,'removed_at',now()),
    rev=nextval('mayak_private.rev')
   where m.file=v_file.path and ((v_file.bucket='mayak-video' and m.kind='video') or (v_file.bucket='mayak' and m.kind in ('photo','voice')));
 end loop;
 return mayak_private.storage_operation(v_operation);
end;
$$;
create function public.mayak_storage_finish(p_actor uuid,p_operation uuid,p_object uuid,p_success boolean,p_error text default null)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare v_item mayak_private.storage_cleanup_items; v_absent boolean;
begin
 perform mayak_private.storage_owner(p_actor); perform mayak_private.storage_lock();
 if not exists(select 1 from mayak_private.storage_operations where id=p_operation and actor=p_actor) then
  raise exception 'Операция очистки не найдена.' using errcode='42501';
 end if;
 select * into v_item from mayak_private.storage_cleanup_items where operation=p_operation and object_id=p_object for update;
 if not found then raise exception 'Файл не выбран для этой операции.'; end if;
 if v_item.status='deleted' then return jsonb_build_object('id',v_item.object_id,'status',v_item.status,'bytes',v_item.bytes,'error',v_item.error); end if;
 select not exists(select 1 from mayak_private.storage_objects() where bucket=v_item.bucket and path=v_item.path) into v_absent;
 update mayak_private.storage_cleanup_items set
  status=case when v_absent then 'deleted' else 'failed' end,
  error=case when v_absent then null when not v_absent then 'Файл ещё находится в хранилище. Повторите очистку.'
    else left(coalesce(p_error,'Не удалось подтвердить удаление файла.'),200) end,updated=now()
  where operation=p_operation and object_id=p_object returning * into v_item;
 update mayak_private.storage_operations set updated=now() where id=p_operation;
 return jsonb_build_object('id',v_item.object_id,'status',v_item.status,'bytes',v_item.bytes,'error',v_item.error);
end;
$$;

-- Preserve direct-chat privacy for photos/voice as strictly as for completed video.
create function mayak_private.media_readable(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select mayak_private.is_member() and (
  exists(select 1 from public.mayak_messages m where m.file=p_path and m.kind in ('photo','voice') and m.deleted is null
   and (m.peer_a is null or auth.uid() in (m.peer_a,m.peer_b)))
  or ((split_part(p_path,'/',1)=auth.uid()::text or exists(
    select 1 from mayak_private.media_release_authorizations r join mayak_private.storage_objects() o on o.id=r.object_id and o.bucket='mayak' and o.path=r.path
     where r.actor=auth.uid() and r.path=p_path))
    and not exists(select 1 from public.mayak_messages m where m.file=p_path and m.deleted is null)));
$$;
create function mayak_private.media_deletable(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select mayak_private.is_member() and (split_part(p_path,'/',1)=auth.uid()::text or exists(
   select 1 from mayak_private.media_release_authorizations r join mayak_private.storage_objects() o on o.id=r.object_id and o.bucket='mayak' and o.path=r.path
    where r.actor=auth.uid() and r.path=p_path))
  and not exists(select 1 from public.mayak_messages m where m.file=p_path and m.deleted is null);
$$;
-- Cleanup retries target immutable paths. An authenticated upload cannot recreate a reserved path
-- between the physical API delete and its acknowledgement, even after that delete succeeded.
create function mayak_private.storage_uploadable(p_bucket text,p_path text) returns boolean
 language sql stable security definer set search_path='' as $$
 select not exists(select 1 from mayak_private.storage_cleanup_items c where c.bucket=p_bucket and c.path=p_path);
$$;
do $$ begin
 if to_regclass('storage.objects') is null then return; end if;
 drop policy if exists mayak_media_read on storage.objects;
 drop policy if exists mayak_media_delete on storage.objects;
 create policy mayak_media_read on storage.objects for select to authenticated
  using(bucket_id='mayak' and mayak_private.media_readable(name));
 create policy mayak_media_delete on storage.objects for delete to authenticated
  using(bucket_id='mayak' and mayak_private.media_deletable(name));
 create policy mayak_reserved_paths_upload on storage.objects as restrictive for insert to authenticated
  with check(mayak_private.storage_uploadable(bucket_id,name));
end $$;
revoke all on function mayak_private.storage_lock(),mayak_private.storage_guard_reference(),mayak_private.storage_owner(uuid),
 mayak_private.storage_objects(),mayak_private.storage_inventory(),mayak_private.storage_operation(uuid),
 public.mayak_storage_overview(uuid,text,integer),public.mayak_storage_prepare(uuid,jsonb,text),
 public.mayak_storage_finish(uuid,uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.mayak_storage_overview(uuid,text,integer),public.mayak_storage_prepare(uuid,jsonb,text),
 public.mayak_storage_finish(uuid,uuid,uuid,boolean,text) to service_role;
revoke all on function mayak_private.media_readable(text),mayak_private.media_deletable(text),mayak_private.storage_uploadable(text,text) from public,anon;
grant execute on function mayak_private.media_readable(text),mayak_private.media_deletable(text),mayak_private.storage_uploadable(text,text) to authenticated;
notify pgrst,'reload schema';
commit;

-- Видеокружочки: исходник закрыт, сообщение создаётся только после доверенной конвертации.
begin;
alter table public.mayak_messages drop constraint mayak_messages_kind_check;
alter table public.mayak_messages add constraint mayak_messages_kind_check
 check (kind in ('text','photo','voice','system','video') and ((kind='text' and file is null) or kind<>'text'));
create table mayak_private.video_config (
 singleton boolean primary key default true check(singleton),
 worker_url text not null,
 worker_key text not null check(length(worker_key)>=32)
);
alter table mayak_private.video_config enable row level security;
revoke all on mayak_private.video_config from public,anon,authenticated;
create table public.mayak_video_jobs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.mayak_members(id) on delete cascade,
 nonce text not null check(length(nonce) between 1 and 100),
 source text not null unique, peer uuid, reply bigint,
 state text not null default 'queued' check(state in ('queued','processing','sent','failed','cancelled')),
 created timestamptz not null default now(), updated timestamptz not null default now(),
 attempt integer not null default 0, ticket uuid, output text, message_id bigint,
 error text, unique(user_id,nonce)
);
create index mayak_video_jobs_user_created on public.mayak_video_jobs(user_id,created);
create index mayak_video_jobs_output on public.mayak_video_jobs(output) where output is not null;
alter table public.mayak_video_jobs enable row level security;
revoke all on public.mayak_video_jobs from public,anon,authenticated;
grant select on public.mayak_video_jobs to authenticated;
create policy video_jobs_read on public.mayak_video_jobs for select to authenticated
 using (user_id=(select auth.uid()) and (select mayak_private.is_member()));

create function mayak_private.video_begin(p_source text,p_nonce text,p_peer uuid,p_reply bigint)
 returns public.mayak_video_jobs language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_job public.mayak_video_jobs; v_reply bigint;
begin
 perform 1 from public.mayak_members where id=v_uid for update;
 if not found then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 select * into v_job from public.mayak_video_jobs where user_id=v_uid and nonce=p_nonce;
 if found then return v_job; end if;
 if not exists(select 1 from mayak_private.video_config) then raise exception 'Обработка видеокружочков ещё настраивается.'; end if;
 if p_nonce is null or length(p_nonce) not between 1 and 100 then raise exception 'Неверный номер отправки.'; end if;
 if p_source is null or p_source !~ ('^'||v_uid::text||'/[a-f0-9]{24}\.(webm|mp4|mov)$') then raise exception 'Неверный файл видео.'; end if;
 if p_peer is not null and (p_peer=v_uid or not exists(select 1 from public.mayak_members where id=p_peer)) then raise exception 'Участник не найден.'; end if;
 if (select count(*) from public.mayak_video_jobs where user_id=v_uid and created>now()-interval '1 hour')>=30 then raise exception 'Слишком много кружочков. Попробуйте позже.'; end if;
 if (select count(*) from public.mayak_video_jobs where user_id=v_uid and state in ('queued','processing') and updated>now()-interval '3 minutes')>=2 then raise exception 'Дождитесь обработки предыдущих кружочков.'; end if;
 perform 1 from storage.objects where bucket_id='mayak-video-source' and name=p_source;
 if not found then raise exception 'Сначала загрузите запись.'; end if;
 select id into v_reply from public.mayak_messages where id=p_reply and deleted is null
  and ((p_peer is null and peer_a is null) or (peer_a=least(v_uid,p_peer) and peer_b=greatest(v_uid,p_peer)));
 insert into public.mayak_video_jobs(user_id,nonce,source,peer,reply) values(v_uid,p_nonce,p_source,p_peer,v_reply) returning * into v_job;
 return v_job;
end;
$$;
create function public.mayak_video_begin(p_source text,p_nonce text,p_peer uuid default null,p_reply bigint default null)
 returns public.mayak_video_jobs language sql security invoker set search_path='' as $$select mayak_private.video_begin(p_source,p_nonce,p_peer,p_reply);$$;

create function mayak_private.video_cancel(p_id uuid) returns public.mayak_video_jobs language plpgsql security definer set search_path='' as $$
declare v_job public.mayak_video_jobs;
begin
 if not mayak_private.is_member() then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 update public.mayak_video_jobs set state=case when state='sent' then state else 'cancelled' end,updated=now()
  where id=p_id and user_id=auth.uid() returning * into v_job;
 if not found then raise exception 'Запись не найдена.' using errcode='42501'; end if;
 return v_job;
end;
$$;
create function public.mayak_video_cancel(p_id uuid) returns public.mayak_video_jobs language sql security invoker set search_path='' as $$select mayak_private.video_cancel(p_id);$$;

-- Служебные вызовы доступны только Edge Function (service_role).
create function mayak_private.video_settings() returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('url',worker_url,'key',worker_key) from mayak_private.video_config where singleton;
$$;
create function public.mayak_video_settings() returns jsonb language sql security invoker set search_path='' as $$select mayak_private.video_settings();$$;
create function mayak_private.video_claim(p_id uuid) returns public.mayak_video_jobs language plpgsql security definer set search_path='' as $$
declare v_job public.mayak_video_jobs; v_ticket uuid:=gen_random_uuid();
begin
 update public.mayak_video_jobs set state='processing',ticket=v_ticket,attempt=attempt+1,updated=now(),error=null,
  output=user_id::text||'/'||id::text||'_'||v_ticket::text||'.mp4'
  where id=p_id and attempt<3 and (state in ('queued','failed') or (state='processing' and updated<now()-interval '3 minutes'))
  returning * into v_job;
 return v_job;
end;
$$;
create function public.mayak_video_claim(p_id uuid) returns public.mayak_video_jobs language sql security invoker set search_path='' as $$select mayak_private.video_claim(p_id);$$;
create function mayak_private.video_finish(p_id uuid,p_ticket uuid,p_meta jsonb,p_error text)
 returns public.mayak_video_jobs language plpgsql security definer set search_path='' as $$
declare v_job public.mayak_video_jobs; v_member public.mayak_members; v_msg public.mayak_messages; v_meta jsonb;
begin
 select * into v_job from public.mayak_video_jobs where id=p_id for update;
 if not found then return null; end if;
 if v_job.state<>'processing' or v_job.ticket is distinct from p_ticket then return v_job; end if;
 if p_error is not null then
  update public.mayak_video_jobs set state='failed',error=left(p_error,200),updated=now() where id=p_id returning * into v_job;
  return v_job;
 end if;
 select * into v_member from public.mayak_members where id=v_job.user_id;
 if not found or (v_job.peer is not null and not exists(select 1 from public.mayak_members where id=v_job.peer)) then
  update public.mayak_video_jobs set state='failed',error='Участник больше не доступен.',updated=now() where id=p_id returning * into v_job; return v_job;
 end if;
 if p_meta->>'video' is distinct from 'h264' or p_meta->>'audio' is distinct from 'aac'
  or (p_meta->>'w')::int is distinct from 480 or (p_meta->>'h')::int is distinct from 480
  or coalesce((p_meta->>'duration')::numeric,0) not between 0.1 and 60.1
  or coalesce((p_meta->>'size')::bigint,0) not between 1 and 8388608 then raise exception 'Неподтверждённый формат видео.'; end if;
 perform 1 from storage.objects where bucket_id='mayak-video' and name=v_job.output;
 if not found then raise exception 'Готовое видео не сохранено.'; end if;
 v_meta:=jsonb_build_object('w',480,'h',480,'duration',(p_meta->>'duration')::numeric,'size',(p_meta->>'size')::bigint,'mime','video/mp4','video','h264','audio','aac','caption',false);
 insert into public.mayak_messages(user_id,name,text,nonce,reply_to,kind,file,file_meta,peer_a,peer_b)
  values(v_member.id,v_member.name,'📹 Видеокружочек',v_job.nonce,v_job.reply,'video',v_job.output,v_meta,
   case when v_job.peer is null then null else least(v_member.id,v_job.peer) end,
   case when v_job.peer is null then null else greatest(v_member.id,v_job.peer) end) returning * into v_msg;
 if v_job.peer is null then update public.mayak_members set last_read=v_msg.id,typing=null where id=v_member.id;
 else insert into public.mayak_reads(user_id,peer,last_read,typing) values(v_member.id,v_job.peer,v_msg.id,null)
  on conflict(user_id,peer) do update set last_read=excluded.last_read,typing=null; end if;
 update public.mayak_video_jobs set state='sent',message_id=v_msg.id,error=null,updated=now() where id=p_id returning * into v_job;
 return v_job;
end;
$$;
create function public.mayak_video_finish(p_id uuid,p_ticket uuid,p_meta jsonb default null,p_error text default null)
 returns public.mayak_video_jobs language sql security invoker set search_path='' as $$select mayak_private.video_finish(p_id,p_ticket,p_meta,p_error);$$;

-- Проверка адресата хранится в БД: знание пути личного кружочка не даёт права его скачать.
create function mayak_private.video_readable(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select mayak_private.is_member() and exists(select 1 from public.mayak_messages m where m.kind='video' and m.file=p_path and m.deleted is null and (m.peer_a is null or auth.uid() in (m.peer_a,m.peer_b)));
$$;
create function mayak_private.video_deletable(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select mayak_private.is_member() and exists(select 1 from public.mayak_video_jobs j where j.output=p_path
  and (j.user_id=auth.uid() or (j.peer is null and exists(select 1 from public.mayak_members where id=auth.uid() and owner))))
  and not exists(select 1 from public.mayak_messages m where m.file=p_path and m.deleted is null);
$$;
do $$ begin
 if not exists(select 1 from pg_namespace where nspname='storage') then return; end if;
 insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
  ('mayak-video-source','mayak-video-source',false,16777216,array['video/mp4','video/webm','video/quicktime']),
  ('mayak-video','mayak-video',false,8388608,array['video/mp4']) on conflict(id) do nothing;
 create policy mayak_video_source_upload on storage.objects for insert to authenticated
  with check(bucket_id='mayak-video-source' and (select mayak_private.is_member()) and name~('^'||(select auth.uid())::text||'/[a-f0-9]{24}\.(mp4|webm|mov)$'));
 create policy mayak_video_source_read on storage.objects for select to authenticated
  using(bucket_id='mayak-video-source' and (select mayak_private.is_member()) and (storage.foldername(name))[1]=(select auth.uid())::text);
 create policy mayak_video_source_delete on storage.objects for delete to authenticated
  using(bucket_id='mayak-video-source' and (select mayak_private.is_member()) and (storage.foldername(name))[1]=(select auth.uid())::text);
 create policy mayak_video_read on storage.objects for select to authenticated
  using(bucket_id='mayak-video' and (mayak_private.video_readable(name) or mayak_private.video_deletable(name)));
 create policy mayak_video_delete on storage.objects for delete to authenticated
  using(bucket_id='mayak-video' and mayak_private.video_deletable(name));
end $$;
revoke all on function mayak_private.video_begin(text,text,uuid,bigint),public.mayak_video_begin(text,text,uuid,bigint),
 mayak_private.video_cancel(uuid),public.mayak_video_cancel(uuid),mayak_private.video_readable(text),mayak_private.video_deletable(text) from public,anon;
grant execute on function mayak_private.video_begin(text,text,uuid,bigint),public.mayak_video_begin(text,text,uuid,bigint),
 mayak_private.video_cancel(uuid),public.mayak_video_cancel(uuid),mayak_private.video_readable(text),mayak_private.video_deletable(text) to authenticated;
revoke all on function mayak_private.video_settings(),public.mayak_video_settings(),mayak_private.video_claim(uuid),public.mayak_video_claim(uuid),
 mayak_private.video_finish(uuid,uuid,jsonb,text),public.mayak_video_finish(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant usage on schema mayak_private to service_role;
grant execute on function mayak_private.video_settings(),public.mayak_video_settings(),mayak_private.video_claim(uuid),public.mayak_video_claim(uuid),
 mayak_private.video_finish(uuid,uuid,jsonb,text),public.mayak_video_finish(uuid,uuid,jsonb,text) to service_role;
notify pgrst,'reload schema';
commit;

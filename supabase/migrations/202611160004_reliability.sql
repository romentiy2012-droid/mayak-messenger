-- Сброс пароля по одноразовой ссылке владельца и повторная отправка уведомлений.
-- Выполнять после 202611160003_features.sql. В push_retry — адрес функции проекта: при смене проекта поправить.
begin;

-- ===== Сброс пароля =====
-- Владелец выдаёт участнику одноразовую ссылку на сутки. Сам пароль меняет Edge Function `reset`
-- через служебный API авторизации; в базе хранится только хэш кода.
create table mayak_private.resets (
 token_hash text primary key,
 user_id uuid not null references public.mayak_members(id) on delete cascade,
 expires timestamptz not null default now() + interval '1 day'
);
alter table mayak_private.resets enable row level security;
revoke all on mayak_private.resets from public, anon, authenticated;

create function mayak_private.reset_issue(p_user uuid) returns text language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
 perform 1 from public.mayak_members where id=auth.uid() and owner;
 if not found then raise exception 'Сбросить пароль может только владелец.' using errcode='42501'; end if;
 if not exists(select 1 from public.mayak_members where id=p_user) then raise exception 'Участник не найден.'; end if;
 -- Новая ссылка отменяет предыдущую для этого участника; просроченные убираются заодно.
 delete from mayak_private.resets where user_id=p_user or expires <= now();
 v_token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
 insert into mayak_private.resets(token_hash,user_id) values(encode(sha256(convert_to(v_token,'UTF8')),'hex'),p_user);
 return v_token;
end;
$$;
create function public.mayak_reset_issue(p_user uuid) returns text language sql security invoker set search_path='' as $$ select mayak_private.reset_issue(p_user); $$;
revoke all on function mayak_private.reset_issue(uuid),public.mayak_reset_issue(uuid) from public,anon;
grant execute on function mayak_private.reset_issue(uuid),public.mayak_reset_issue(uuid) to authenticated;

-- Только для Edge Function (service_role): проверить код и погасить его после смены пароля.
create function public.mayak_reset_check(p_token text) returns uuid language sql security definer set search_path = '' as $$
 select user_id from mayak_private.resets
  where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and expires > now();
$$;
create function public.mayak_reset_done(p_token text) returns void language sql security definer set search_path = '' as $$
 delete from mayak_private.resets where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
$$;
revoke all on function public.mayak_reset_check(text),public.mayak_reset_done(text) from public,anon,authenticated;
grant execute on function public.mayak_reset_check(text),public.mayak_reset_done(text) to service_role;

-- ===== Надёжность уведомлений =====
-- Раньше сообщение помечалось отправленным до доставки, и при сбое повтора не было.
-- Теперь pushed ставится только после ответа push-сервисов; несостоявшиеся подписки запоминаются
-- в push_pending, и повтор идёт только по ним. Попыток не больше шести, в течение 15 минут.
alter table public.mayak_messages
 add column if not exists push_tries smallint not null default 0,
 add column if not exists push_at timestamptz,
 add column if not exists push_pending text[];
-- Старые сообщения в повторах не участвуют.
update public.mayak_messages set pushed=created where pushed is null and created < now()-interval '15 minutes';
create index if not exists mayak_messages_unpushed on public.mayak_messages(created) where pushed is null;

create or replace function public.mayak_push_claim(p_id bigint) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_key text; v_subs jsonb;
begin
 -- Одна попытка за раз: следующая возможна не раньше чем через 20 секунд.
 update public.mayak_messages set push_at=now(),push_tries=push_tries+1
  where id=p_id and pushed is null and deleted is null and created > now()-interval '15 minutes'
   and push_tries < 6 and (push_at is null or push_at < now()-interval '20 seconds') returning * into v_msg;
 if not found then return null; end if;
 select jsonb_agg(jsonb_build_object('endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth,
   'badge',(select count(*) from public.mayak_messages x where x.id>m.last_read and x.user_id<>m.id and x.deleted is null)))
  into v_subs
  from mayak_private.push_subscriptions s join public.mayak_members m on m.id=s.user_id
  where s.user_id<>v_msg.user_id and (v_msg.push_pending is null or s.endpoint=any(v_msg.push_pending));
 if v_subs is null then
  update public.mayak_messages set pushed=now(),push_pending=null where id=p_id;
  return null;
 end if;
 begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name='mayak_vapid_private_key';
 exception when others then v_key := null;
 end;
 return jsonb_build_object('vapid',v_key,'id',v_msg.id,'title',v_msg.name,'body',left(v_msg.text,200),'subscriptions',v_subs);
end;
$$;
-- Итог попытки: p_gone — подписки, которых больше нет; p_failed — временно не принявшие (повторить позже).
create function public.mayak_push_result(p_id bigint, p_failed text[], p_gone text[]) returns void language plpgsql security definer set search_path = '' as $$
begin
 delete from mayak_private.push_subscriptions where endpoint=any(coalesce(p_gone,'{}'::text[]));
 if coalesce(cardinality(p_failed),0)=0 then
  update public.mayak_messages set pushed=now(),push_pending=null where id=p_id and pushed is null;
 else
  update public.mayak_messages set push_pending=p_failed where id=p_id and pushed is null;
 end if;
end;
$$;
revoke all on function public.mayak_push_claim(bigint),public.mayak_push_result(bigint,text[],text[]) from public,anon,authenticated;
grant execute on function public.mayak_push_claim(bigint),public.mayak_push_result(bigint,text[],text[]) to service_role;

-- Раз в минуту: заново вызвать функцию push для сообщений, уведомление о которых ещё не доставлено
-- (сбой функции, push-сервиса или самого вызова из триггера).
create function mayak_private.push_retry() returns void language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
 for v_id in select id from public.mayak_messages
   where pushed is null and deleted is null and push_tries < 6
    and created > now()-interval '15 minutes' and created < now()-interval '30 seconds'
    and (push_at is null or push_at < now()-interval '45 seconds')
   order by id limit 20
 loop
  begin
   perform net.http_post(
    url := 'https://cfzzxkmctwrclhphqslr.supabase.co/functions/v1/push',
    body := jsonb_build_object('id', v_id),
    headers := '{"Content-Type":"application/json"}'::jsonb);
  exception when others then null;
  end;
 end loop;
end;
$$;
revoke all on function mayak_private.push_retry() from public,anon,authenticated;
do $$ begin
 create extension if not exists pg_cron;
 perform cron.unschedule(jobid) from cron.job where jobname in ('mayak-push-retry','mayak-cron-cleanup');
 perform cron.schedule('mayak-push-retry','* * * * *','select mayak_private.push_retry()');
 -- Журнал запусков cron растёт на строку в минуту — хранить два дня.
 perform cron.schedule('mayak-cron-cleanup','17 3 * * *','delete from cron.job_run_details where end_time < now() - interval ''2 days''');
exception when others then
 raise notice 'pg_cron недоступен, повтор уведомлений по расписанию выключен: %', sqlerrm;
end $$;
notify pgrst, 'reload schema';
commit;

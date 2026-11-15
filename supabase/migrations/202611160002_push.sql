-- Web Push: подписки устройств и вызов Edge Function `push` при новом сообщении.
-- Выполнить один раз в SQL Editor после 202611160001_cloud.sql.
begin;
do $$ begin
 create extension if not exists pg_net;
exception when others then
 raise notice 'pg_net недоступен: %', sqlerrm;
end $$;

alter table public.mayak_messages add column if not exists pushed timestamptz;

create table mayak_private.push_subscriptions (
 endpoint text primary key check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
 user_id uuid not null references public.mayak_members(id) on delete cascade,
 p256dh text not null check (char_length(p256dh) between 80 and 100),
 auth text not null check (char_length(auth) between 16 and 40),
 created timestamptz not null default now()
);
create index push_subscriptions_user on mayak_private.push_subscriptions(user_id, created desc);
alter table mayak_private.push_subscriptions enable row level security;
revoke all on mayak_private.push_subscriptions from public, anon, authenticated;

create function mayak_private.push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
 if not exists(select 1 from public.mayak_members where id=v_uid) then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 insert into mayak_private.push_subscriptions(endpoint,user_id,p256dh,auth) values(p_endpoint,v_uid,p_p256dh,p_auth)
  on conflict (endpoint) do update set user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,created=now();
 -- Не больше 10 устройств на участника: самые старые подписки удаляются.
 delete from mayak_private.push_subscriptions where user_id=v_uid and endpoint not in
  (select endpoint from mayak_private.push_subscriptions where user_id=v_uid order by created desc limit 10);
end;
$$;
create function mayak_private.push_unsubscribe(p_endpoint text) returns void language sql security definer set search_path = '' as $$
 delete from mayak_private.push_subscriptions where endpoint=p_endpoint and user_id=auth.uid();
$$;
create function public.mayak_push_subscribe(p_endpoint text,p_p256dh text,p_auth text) returns void language sql security invoker set search_path='' as $$ select mayak_private.push_subscribe(p_endpoint,p_p256dh,p_auth); $$;
create function public.mayak_push_unsubscribe(p_endpoint text) returns void language sql security invoker set search_path='' as $$ select mayak_private.push_unsubscribe(p_endpoint); $$;
revoke all on function mayak_private.push_subscribe(text,text,text),mayak_private.push_unsubscribe(text) from public,anon;
grant execute on function mayak_private.push_subscribe(text,text,text),mayak_private.push_unsubscribe(text) to authenticated;
revoke all on function public.mayak_push_subscribe(text,text,text),public.mayak_push_unsubscribe(text) from public,anon;
grant execute on function public.mayak_push_subscribe(text,text,text),public.mayak_push_unsubscribe(text) to authenticated;

-- Только для Edge Function (service_role). Сообщение выдаётся один раз и только свежее,
-- поэтому повторный или посторонний вызов функции ничего не отправит.
create function public.mayak_push_claim(p_id bigint) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_msg public.mayak_messages; v_key text;
begin
 update public.mayak_messages set pushed=now()
  where id=p_id and pushed is null and created > now()-interval '5 minutes' returning * into v_msg;
 if not found then return null; end if;
 -- Приватный VAPID-ключ хранится в Supabase Vault (имя mayak_vapid_private_key), не в репозитории.
 begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name='mayak_vapid_private_key';
 exception when others then v_key := null;
 end;
 return jsonb_build_object('vapid',v_key,'id',v_msg.id,'title',v_msg.name,'body',left(v_msg.text,200),
  'subscriptions',coalesce((select jsonb_agg(jsonb_build_object('endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth))
   from mayak_private.push_subscriptions s where s.user_id<>v_msg.user_id),'[]'::jsonb));
end;
$$;
create function public.mayak_push_drop(p_endpoints text[]) returns void language sql security definer set search_path = '' as $$
 delete from mayak_private.push_subscriptions where endpoint=any(p_endpoints);
$$;
revoke all on function public.mayak_push_claim(bigint),public.mayak_push_drop(text[]) from public,anon,authenticated;
grant execute on function public.mayak_push_claim(bigint),public.mayak_push_drop(text[]) to service_role;

-- Ошибка уведомления никогда не мешает отправке сообщения.
create function mayak_private.push_notify() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 begin
  perform net.http_post(
   url := 'https://jqmkjwsptxhovfxngqiy.supabase.co/functions/v1/push',
   body := jsonb_build_object('id', new.id),
   headers := '{"Content-Type":"application/json"}'::jsonb);
 exception when others then null;
 end;
 return new;
end;
$$;
revoke all on function mayak_private.push_notify() from public,anon,authenticated;
create trigger mayak_messages_push after insert on public.mayak_messages for each row execute function mayak_private.push_notify();
notify pgrst, 'reload schema';
commit;

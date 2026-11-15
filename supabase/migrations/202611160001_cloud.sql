begin;
create schema if not exists mayak_private;
revoke all on schema mayak_private from public, anon;
grant usage on schema mayak_private to authenticated;

create table public.mayak_members (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null check (char_length(btrim(name)) between 1 and 32),
 owner boolean not null default false,
 last_seen timestamptz not null default now()
);
create table public.mayak_messages (
 id bigint generated always as identity primary key,
 user_id uuid not null references public.mayak_members(id),
 name text not null,
 text text not null check (char_length(btrim(text)) between 1 and 2000),
 nonce text not null check (char_length(nonce) between 1 and 100),
 created timestamptz not null default now(),
 unique(user_id, nonce)
);
create index mayak_messages_user_created on public.mayak_messages(user_id, created desc);
create table mayak_private.invites (
 token_hash text primary key,
 owner boolean not null default false,
 expires timestamptz not null default now() + interval '7 days',
 remaining integer not null default 1 check (remaining >= 0)
);
alter table public.mayak_members enable row level security;
alter table public.mayak_messages enable row level security;
alter table mayak_private.invites enable row level security;
revoke all on public.mayak_members, public.mayak_messages from public, anon, authenticated;
revoke all on mayak_private.invites from public, anon, authenticated;
revoke all on sequence public.mayak_messages_id_seq from public, anon, authenticated;
grant select on public.mayak_members, public.mayak_messages to authenticated;

create function mayak_private.is_member() returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.mayak_members where id = (select auth.uid()));
$$;
create policy members_read on public.mayak_members for select to authenticated using ((select mayak_private.is_member()));
create policy messages_read on public.mayak_messages for select to authenticated using ((select mayak_private.is_member()));

create function mayak_private.redeem(p_token text, p_name text) returns void language plpgsql security definer set search_path = '' as $$
declare v_inv mayak_private.invites; v_uid uuid := auth.uid();
begin
 if v_uid is null then raise exception 'Войдите в аккаунт.' using errcode='28000'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
 if exists(select 1 from public.mayak_members where id=v_uid) then return; end if;
 if p_name is null or char_length(btrim(p_name)) not between 1 and 32 then raise exception 'Укажите имя от 1 до 32 символов.'; end if;
 select * into v_inv from mayak_private.invites where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') for update;
 if not found or v_inv.expires <= now() or v_inv.remaining < 1 then raise exception 'Приглашение недействительно или уже использовано.'; end if;
 insert into public.mayak_members(id,name,owner) values(v_uid,btrim(p_name),v_inv.owner);
 update mayak_private.invites set remaining=remaining-1 where token_hash=v_inv.token_hash;
end;
$$;
create function mayak_private.send(p_text text, p_nonce text) returns public.mayak_messages language plpgsql security definer set search_path = '' as $$
declare v_member public.mayak_members; v_msg public.mayak_messages;
begin
 select * into v_member from public.mayak_members where id=auth.uid() for update;
 if not found then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 select * into v_msg from public.mayak_messages where user_id=v_member.id and nonce=p_nonce;
 if found then return v_msg; end if;
 if p_text is null or char_length(btrim(p_text)) not between 1 and 2000 then raise exception 'Сообщение должно содержать от 1 до 2000 символов.'; end if;
 if p_nonce is null or char_length(p_nonce) not between 1 and 100 then raise exception 'Неверный идентификатор сообщения.'; end if;
 if exists(select 1 from public.mayak_messages where user_id=v_member.id and created > clock_timestamp()-interval '500 milliseconds') then raise exception 'Слишком быстро. Повторите через секунду.'; end if;
 insert into public.mayak_messages(user_id,name,text,nonce) values(v_member.id,v_member.name,btrim(p_text),p_nonce) returning * into v_msg;
 return v_msg;
end;
$$;
create function mayak_private.profile(p_name text default null) returns public.mayak_members language plpgsql security definer set search_path = '' as $$
declare v_member public.mayak_members;
begin
 if p_name is not null and char_length(btrim(p_name)) not between 1 and 32 then raise exception 'Укажите имя от 1 до 32 символов.'; end if;
 update public.mayak_members set name=coalesce(btrim(p_name),name),last_seen=now() where id=auth.uid() returning * into v_member;
 if not found then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 return v_member;
end;
$$;
create function mayak_private.invite() returns text language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
 perform 1 from public.mayak_members where id=auth.uid() and owner for update;
 if not found then raise exception 'Приглашать может только владелец.' using errcode='42501'; end if;
 -- Each new invitation invalidates unused guest invitations; owner bootstrap is untouched.
 delete from mayak_private.invites where not owner;
 v_token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
 insert into mayak_private.invites(token_hash) values(encode(sha256(convert_to(v_token,'UTF8')),'hex'));
 return v_token;
end;
$$;
-- Public RPC wrappers run as the caller; privileged implementation stays outside the exposed schema.
create function public.mayak_redeem(p_token text,p_name text) returns void language sql security invoker set search_path='' as $$ select mayak_private.redeem(p_token,p_name); $$;
create function public.mayak_send(p_text text,p_nonce text) returns public.mayak_messages language sql security invoker set search_path='' as $$ select mayak_private.send(p_text,p_nonce); $$;
create function public.mayak_profile(p_name text default null) returns public.mayak_members language sql security invoker set search_path='' as $$ select mayak_private.profile(p_name); $$;
create function public.mayak_invite() returns text language sql security invoker set search_path='' as $$ select mayak_private.invite(); $$;
revoke all on all functions in schema mayak_private from public, anon;
grant execute on all functions in schema mayak_private to authenticated;
revoke all on function public.mayak_redeem(text,text),public.mayak_send(text,text),public.mayak_profile(text),public.mayak_invite() from public,anon;
grant execute on function public.mayak_redeem(text,text),public.mayak_send(text,text),public.mayak_profile(text),public.mayak_invite() to authenticated;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  alter publication supabase_realtime add table public.mayak_messages;
 end if;
end $$;
commit;

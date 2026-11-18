-- Опросы: в публичном сообщении только вопрос и агрегаты. Бюллетени закрыты.
begin;
alter table public.mayak_messages drop constraint mayak_messages_kind_check;
alter table public.mayak_messages add constraint mayak_messages_kind_check
 check (kind in ('text','photo','voice','system','video','poll') and ((kind in ('text','poll') and file is null) or kind not in ('text','poll')));

create table mayak_private.polls (
 message_id bigint primary key references public.mayak_messages(id) on delete cascade,
 question text not null,
 options text[] not null,
 multiple boolean not null,
 anonymous boolean not null,
 closed_at timestamptz,
 request_reply bigint
);
create table mayak_private.poll_votes (
 message_id bigint not null references mayak_private.polls(message_id) on delete cascade,
 user_id uuid not null,
 choices integer[] not null,
 primary key(message_id,user_id)
);
-- Сохраняем применённые запросы: запоздалый повтор не возвращает прежний выбор.
create table mayak_private.poll_requests (
 message_id bigint not null references mayak_private.polls(message_id) on delete cascade,
 user_id uuid not null,
 nonce text not null,
 choices integer[] not null,
 primary key(message_id,user_id,nonce)
);
alter table mayak_private.polls enable row level security;
alter table mayak_private.poll_votes enable row level security;
alter table mayak_private.poll_requests enable row level security;
revoke all on mayak_private.polls,mayak_private.poll_votes,mayak_private.poll_requests from public,anon,authenticated;

create function mayak_private.poll_get(p_id bigint,p_voters boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_msg public.mayak_messages; v_poll mayak_private.polls; v_uid uuid:=auth.uid(); v_mine integer[]; v_voters jsonb;
begin
 if not exists(select 1 from public.mayak_members where id=v_uid) then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 select * into v_msg from public.mayak_messages where id=p_id and kind='poll' and deleted is null
  and (peer_a is null or v_uid in(peer_a,peer_b)) for share;
 if not found then raise exception 'Опрос недоступен.' using errcode='42501'; end if;
 select * into strict v_poll from mayak_private.polls where message_id=p_id;
 select choices into v_mine from mayak_private.poll_votes where message_id=p_id and user_id=v_uid;
 if p_voters then
  if v_poll.anonymous then raise exception 'В анонимном опросе имена участников скрыты.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',v.user_id,'name',coalesce(m.name,'Удалённый участник'),'choices',v.choices) order by coalesce(m.name,''),v.user_id),'[]')
   into v_voters from mayak_private.poll_votes v left join public.mayak_members m on m.id=v.user_id where v.message_id=p_id;
 end if;
 return jsonb_build_object('message',to_jsonb(v_msg),'mine',coalesce(v_mine,'{}'::integer[]),'voters',v_voters,
  'can_close',v_msg.user_id=v_uid or (v_msg.peer_a is null and exists(select 1 from public.mayak_members where id=v_uid and owner)));
end; $$;

-- Вызывается только из серверных функций под тем же lock сообщения.
create function mayak_private.poll_refresh(p_id bigint) returns void
language plpgsql security definer set search_path='' as $$
declare v_poll mayak_private.polls; v_options jsonb; v_total bigint;
begin
 select * into strict v_poll from mayak_private.polls where message_id=p_id;
 select count(*) into v_total from mayak_private.poll_votes where message_id=p_id;
 select jsonb_agg(jsonb_build_object('id',o.n,'text',o.label,'count',
  (select count(*) from mayak_private.poll_votes v where v.message_id=p_id and o.n::integer=any(v.choices))) order by o.n)
  into v_options from unnest(v_poll.options) with ordinality o(label,n);
 update public.mayak_messages set file_meta=jsonb_build_object('question',v_poll.question,'options',v_options,
  'multiple',v_poll.multiple,'anonymous',v_poll.anonymous,'closed_at',v_poll.closed_at,'total',v_total),rev=nextval('mayak_private.rev') where id=p_id;
end; $$;

create function mayak_private.poll_create(p_question text,p_options text[],p_multiple boolean,p_anonymous boolean,p_nonce text,p_peer uuid default null,p_reply bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_member public.mayak_members; v_msg public.mayak_messages; v_poll mayak_private.polls; v_options text[]; v_question text:=btrim(p_question); v_a uuid; v_b uuid; v_reply bigint;
begin
 select * into v_member from public.mayak_members where id=auth.uid() for update;
 if not found then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 if v_question is null or char_length(v_question) not between 1 and 300 then raise exception 'Вопрос должен содержать от 1 до 300 символов.'; end if;
 if p_options is null or cardinality(p_options) not between 2 and 10 or array_ndims(p_options)<>1 then raise exception 'Нужно от 2 до 10 вариантов.'; end if;
 select array_agg(btrim(x) order by n) into v_options from unnest(p_options) with ordinality o(x,n);
 if exists(select 1 from unnest(v_options) x where x is null or char_length(x) not between 1 and 100)
  or (select count(distinct lower(x)) from unnest(v_options) x)<>cardinality(v_options) then raise exception 'Варианты должны быть разными, от 1 до 100 символов.'; end if;
 if p_multiple is null or p_anonymous is null or p_nonce is null or char_length(p_nonce) not between 1 and 100 then raise exception 'Неверные настройки опроса.'; end if;
 if p_peer is not null then
  if p_peer=v_member.id then raise exception 'Участник не найден.'; end if;
  v_a:=least(v_member.id,p_peer);v_b:=greatest(v_member.id,p_peer);
 end if;
 select * into v_msg from public.mayak_messages where user_id=v_member.id and nonce=p_nonce;
 if found then
  select * into v_poll from mayak_private.polls where message_id=v_msg.id;
  if not found or v_msg.deleted is not null or v_msg.kind<>'poll' or v_poll.question<>v_question or v_poll.options<>v_options
   or v_poll.multiple<>p_multiple or v_poll.anonymous<>p_anonymous or v_msg.peer_a is distinct from v_a or v_msg.peer_b is distinct from v_b
   or v_poll.request_reply is distinct from p_reply then raise exception 'Этот запрос уже использован. Обновите опрос.' using errcode='22023'; end if;
  return mayak_private.poll_get(v_msg.id);
 end if;
 if p_peer is not null and not exists(select 1 from public.mayak_members where id=p_peer) then raise exception 'Участник не найден.'; end if;
 if exists(select 1 from public.mayak_messages where user_id=v_member.id and created>clock_timestamp()-interval '500 milliseconds') then raise exception 'Слишком быстро. Повторите через секунду.'; end if;
 select id into v_reply from public.mayak_messages where id=p_reply and deleted is null and peer_a is not distinct from v_a and peer_b is not distinct from v_b;
 insert into public.mayak_messages(user_id,name,text,nonce,reply_to,kind,peer_a,peer_b)
  values(v_member.id,v_member.name,'📊 '||v_question,p_nonce,v_reply,'poll',v_a,v_b) returning * into v_msg;
 insert into mayak_private.polls values(v_msg.id,v_question,v_options,p_multiple,p_anonymous,null,p_reply);
 perform mayak_private.poll_refresh(v_msg.id);
 if p_peer is null then update public.mayak_members set last_read=v_msg.id,typing=null where id=v_member.id;
 else insert into public.mayak_reads(user_id,peer,last_read,typing) values(v_member.id,p_peer,v_msg.id,null)
  on conflict(user_id,peer) do update set last_read=excluded.last_read,typing=null; end if;
 return mayak_private.poll_get(v_msg.id);
end; $$;

create function mayak_private.poll_vote(p_id bigint,p_choices integer[],p_nonce text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_msg public.mayak_messages; v_poll mayak_private.polls; v_uid uuid:=auth.uid(); v_choices integer[]; v_prior integer[]; v_current integer[];
begin
 if not exists(select 1 from public.mayak_members where id=v_uid) then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 -- Все изменения: сначала сообщение, затем приватные записи. Close/delete используют тот же порядок.
 select * into v_msg from public.mayak_messages where id=p_id and kind='poll' and deleted is null
  and (peer_a is null or v_uid in(peer_a,peer_b)) for update;
 if not found then raise exception 'Опрос недоступен.' using errcode='42501'; end if;
 select * into strict v_poll from mayak_private.polls where message_id=p_id;
 if p_choices is null or cardinality(p_choices)>10 or coalesce(array_ndims(p_choices),1)<>1 or p_nonce is null or char_length(p_nonce) not between 1 and 100 then raise exception 'Неверный выбор.'; end if;
 if exists(select 1 from unnest(p_choices) x where x is null or x<1 or x>cardinality(v_poll.options)) then raise exception 'Такого варианта нет.'; end if;
 select coalesce(array_agg(distinct x order by x),'{}'::integer[]) into v_choices from unnest(p_choices) x;
 if not v_poll.multiple and cardinality(v_choices)>1 then raise exception 'Выбери один вариант.'; end if;
 select choices into v_prior from mayak_private.poll_requests where message_id=p_id and user_id=v_uid and nonce=p_nonce;
 if found then
  if v_prior<>v_choices then raise exception 'Номер запроса уже использован для другого выбора.' using errcode='22023'; end if;
  return mayak_private.poll_get(p_id);
 end if;
 if v_poll.closed_at is not null then raise exception 'Голосование уже завершено.'; end if;
 select choices into v_current from mayak_private.poll_votes where message_id=p_id and user_id=v_uid;
 insert into mayak_private.poll_requests values(p_id,v_uid,p_nonce,v_choices);
 if coalesce(v_current,'{}'::integer[]) is distinct from v_choices then
  if cardinality(v_choices)=0 then delete from mayak_private.poll_votes where message_id=p_id and user_id=v_uid;
  else insert into mayak_private.poll_votes values(p_id,v_uid,v_choices) on conflict(message_id,user_id) do update set choices=excluded.choices; end if;
  perform mayak_private.poll_refresh(p_id);
 end if;
 return mayak_private.poll_get(p_id);
end; $$;

create function mayak_private.poll_close(p_id bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_msg public.mayak_messages; v_uid uuid:=auth.uid();
begin
 if not exists(select 1 from public.mayak_members where id=v_uid) then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 select * into v_msg from public.mayak_messages where id=p_id and kind='poll' and deleted is null
  and (peer_a is null or v_uid in(peer_a,peer_b)) for update;
 if not found or not coalesce(v_msg.user_id=v_uid or (v_msg.peer_a is null and exists(select 1 from public.mayak_members where id=v_uid and owner)),false) then raise exception 'Завершить опрос может автор или админ общего чата.' using errcode='42501'; end if;
 update mayak_private.polls set closed_at=now() where message_id=p_id and closed_at is null;
 if found then perform mayak_private.poll_refresh(p_id); end if;
 return mayak_private.poll_get(p_id);
end; $$;

create function public.mayak_poll_get(p_id bigint,p_voters boolean default false) returns jsonb language sql security invoker set search_path='' as $$select mayak_private.poll_get(p_id,p_voters)$$;
create function public.mayak_poll_create(p_question text,p_options text[],p_multiple boolean,p_anonymous boolean,p_nonce text,p_peer uuid default null,p_reply bigint default null) returns jsonb language sql security invoker set search_path='' as $$select mayak_private.poll_create(p_question,p_options,p_multiple,p_anonymous,p_nonce,p_peer,p_reply)$$;
create function public.mayak_poll_vote(p_id bigint,p_choices integer[],p_nonce text) returns jsonb language sql security invoker set search_path='' as $$select mayak_private.poll_vote(p_id,p_choices,p_nonce)$$;
create function public.mayak_poll_close(p_id bigint) returns jsonb language sql security invoker set search_path='' as $$select mayak_private.poll_close(p_id)$$;
revoke all on function mayak_private.poll_refresh(bigint),mayak_private.poll_get(bigint,boolean),mayak_private.poll_create(text,text[],boolean,boolean,text,uuid,bigint),mayak_private.poll_vote(bigint,integer[],text),mayak_private.poll_close(bigint),public.mayak_poll_get(bigint,boolean),public.mayak_poll_create(text,text[],boolean,boolean,text,uuid,bigint),public.mayak_poll_vote(bigint,integer[],text),public.mayak_poll_close(bigint) from public,anon,authenticated;
grant execute on function mayak_private.poll_get(bigint,boolean),mayak_private.poll_create(text,text[],boolean,boolean,text,uuid,bigint),mayak_private.poll_vote(bigint,integer[],text),mayak_private.poll_close(bigint),public.mayak_poll_get(bigint,boolean),public.mayak_poll_create(text,text[],boolean,boolean,text,uuid,bigint),public.mayak_poll_vote(bigint,integer[],text),public.mayak_poll_close(bigint) to authenticated;
commit;

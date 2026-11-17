-- Служебная строка в общем чате: «<имя> добавлен в чат». Появляется сама, когда в чат входит новый участник
-- (по приглашению). Владелец при первом входе строки не получает. Выполнять после 202611160007_direct.sql.

alter table public.mayak_messages drop constraint if exists mayak_messages_kind_check;
alter table public.mayak_messages add constraint mayak_messages_kind_check
 check (kind in ('text','photo','voice','system') and ((kind='text' and file is null) or kind<>'text'));

-- У служебной строки нет автора (user_id пуст): уведомление по ней не рассылается, в счётчик непрочитанных она не входит.
create function mayak_private.member_joined() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 insert into public.mayak_messages(user_id,name,text,nonce,kind)
  values(null,new.name,new.name || ' добавлен в чат','join:' || new.id::text,'system');
 return new;
end;
$$;
revoke all on function mayak_private.member_joined() from public,anon,authenticated;
create trigger mayak_members_joined after insert on public.mayak_members for each row
 when (not new.owner) execute function mayak_private.member_joined();
notify pgrst, 'reload schema';

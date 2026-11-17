-- Аватарка участника: готовый значок либо собственное фото. Старые профили остаются с буквами.
begin;
alter table public.mayak_members
 add column avatar_icon text,
 add column avatar_file text,
 add constraint mayak_member_avatar_check check (
  (avatar_icon is null or avatar_icon in ('cat','dog','fox','bear','panda','owl','wolf','whale',
   'car','rocket','ship','bike','key','heart','star','sun','moon','flower','tree','cactus','guitar','ball','anchor','compass'))
  and (avatar_file is null or avatar_file ~ ('^' || id::text || '/[a-f0-9]{24}\.jpg$'))
  and not (avatar_icon is not null and avatar_file is not null)
 );
create unique index mayak_members_avatar_file_idx on public.mayak_members(avatar_file) where avatar_file is not null;

-- Атомарно сохраняет имя и аватарку только вызывающего участника.
create function mayak_private.profile_avatar(p_name text,p_icon text,p_file text)
 returns public.mayak_members language plpgsql security definer set search_path='' as $$
declare v_member public.mayak_members;
begin
 select * into v_member from public.mayak_members where id=auth.uid() for update;
 if not found then raise exception 'Нет доступа к чату.' using errcode='42501'; end if;
 if p_name is null or char_length(btrim(p_name)) not between 1 and 32 then raise exception 'Укажите имя от 1 до 32 символов.'; end if;
 if p_icon is not null and p_file is not null then raise exception 'Выберите фото или значок.'; end if;
 if p_icon is not null and p_icon not in ('cat','dog','fox','bear','panda','owl','wolf','whale',
  'car','rocket','ship','bike','key','heart','star','sun','moon','flower','tree','cactus','guitar','ball','anchor','compass') then
  raise exception 'Выберите значок из списка.';
 end if;
 if p_file is not null then
  if p_file !~ ('^' || v_member.id::text || '/[a-f0-9]{24}\.jpg$') then raise exception 'Можно выбрать только своё фото.'; end if;
  perform 1 from storage.objects where bucket_id='mayak-avatars' and name=p_file for update;
  if not found then raise exception 'Сначала загрузите фото. Попробуйте ещё раз.'; end if;
 end if;
 update public.mayak_members set name=btrim(p_name),avatar_icon=p_icon,avatar_file=p_file,last_seen=now()
  where id=v_member.id returning * into v_member;
 return v_member;
end;
$$;
create function public.mayak_profile_avatar(p_name text,p_icon text default null,p_file text default null)
 returns public.mayak_members language sql security invoker set search_path='' as $$
 select mayak_private.profile_avatar(p_name,p_icon,p_file);
$$;
revoke all on function mayak_private.profile_avatar(text,text,text),public.mayak_profile_avatar(text,text,text) from public,anon;
grant execute on function mayak_private.profile_avatar(text,text,text),public.mayak_profile_avatar(text,text,text) to authenticated;

-- Отдельный закрытый бакет. Фото неизменяемы: каждая загрузка получает новый случайный путь.
-- Читают только участники; загрузка только в свою папку, удаление только своего неиспользуемого фото.
do $$ begin
 if not exists(select 1 from pg_namespace where nspname='storage') then return; end if;
 insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('mayak-avatars','mayak-avatars',false,512000,array['image/jpeg'])
  on conflict(id) do nothing;
 create policy mayak_avatar_read on storage.objects for select to authenticated
  using (bucket_id='mayak-avatars' and (select mayak_private.is_member())
   and (exists(select 1 from public.mayak_members m where m.avatar_file=storage.objects.name)
    or name ~ ('^' || (select auth.uid())::text || '/[a-f0-9]{24}\.jpg$')));
 create policy mayak_avatar_upload on storage.objects for insert to authenticated
  with check (bucket_id='mayak-avatars' and (select mayak_private.is_member())
   and name ~ ('^' || (select auth.uid())::text || '/[a-f0-9]{24}\.jpg$'));
 create policy mayak_avatar_delete on storage.objects for delete to authenticated
  using (bucket_id='mayak-avatars' and (select mayak_private.is_member())
   and name ~ ('^' || (select auth.uid())::text || '/[a-f0-9]{24}\.jpg$')
   and not exists(select 1 from public.mayak_members m where m.avatar_file=storage.objects.name));
end $$;
notify pgrst, 'reload schema';
commit;

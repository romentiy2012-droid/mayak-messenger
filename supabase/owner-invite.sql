-- Run only in the administrator SQL editor after the migration.
-- The result is a private one-use owner code. Never commit it or post it publicly.
-- Refuse to issue another owner token once a chat owner exists.
with token as (
 select replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','') as value
 where not exists(select 1 from public.mayak_members where owner)
), invalidate as (
 delete from mayak_private.invites where owner
), inserted as (
 insert into mayak_private.invites(token_hash,owner)
 select encode(sha256(convert_to(value,'UTF8')),'hex'),true from token
 returning token_hash
)
select value as owner_invite_code from token join inserted on token_hash=encode(sha256(convert_to(value,'UTF8')),'hex');

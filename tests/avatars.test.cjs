const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');

test('avatars: atomic own profile, private storage, active file protection and safe replacement',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
   create schema auth; create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
   create schema storage;
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
   create function storage.foldername(text) returns text[] language sql as $$select array[split_part($1,'/',1)]$$;
   alter table storage.objects enable row level security;
   grant usage on schema storage to authenticated,anon;
   grant select,insert,update,delete on storage.objects to authenticated,anon;`);
  for(const file of fs.readdirSync('supabase/migrations').sort()) await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
  const owner='00000000-0000-4000-8000-000000000001', guest='00000000-0000-4000-8000-000000000002', outsider='00000000-0000-4000-8000-000000000003';
  await db.exec(`insert into auth.users values('${owner}'),('${guest}'),('${outsider}'); insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner-code','UTF8')),'hex'),true);`);
  const as=async id=>db.exec(`reset role; select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`);
  const profile=async(name,icon=null,file=null)=>(await db.query('select (m).id,(m).name,(m).avatar_icon,(m).avatar_file from public.mayak_profile_avatar($1,$2,$3) m',[name,icon,file])).rows[0];
  const upload=file=>db.query("insert into storage.objects values('mayak-avatars',$1)",[file]);
  const visible=async()=> (await db.query("select name from storage.objects where bucket_id='mayak-avatars' order by name")).rows.map(row=>row.name);
  const remove=file=>db.query("delete from storage.objects where bucket_id='mayak-avatars' and name=$1 returning name",[file]);
  await as(owner); await db.query("select public.mayak_redeem('owner-code','Кэп')");
  const token=(await db.query('select public.mayak_invite() as token')).rows[0].token;
  await as(guest); await db.query('select public.mayak_redeem($1,$2)',[token,'Гость']);
  assert.deepEqual(await profile('Гость','cat'),{id:guest,name:'Гость',avatar_icon:'cat',avatar_file:null});
  const first=guest+'/'+'a'.repeat(24)+'.jpg', second=guest+'/'+'b'.repeat(24)+'.jpg';
  await assert.rejects(profile('Не сохранится','unknown'));
  await assert.rejects(profile('Не сохранится',null,first)); // не загружен
  assert.equal((await db.query('select name from mayak_members where id=$1',[guest])).rows[0].name,'Гость');
  await assert.rejects(upload(owner+'/'+'a'.repeat(24)+'.jpg'));
  await assert.rejects(upload(guest+'/../escape.jpg'));
  await upload(first); await upload(second);
  await assert.rejects(profile('Гость','dog',first));
  await assert.rejects(profile('Гость',null,owner+'/'+'a'.repeat(24)+'.jpg'));
  assert.equal((await profile('Гость с фото',null,first)).avatar_file,first);
  assert.equal((await remove(first)).rows.length,0); // действующее фото нельзя удалить
  await assert.rejects(db.query('update public.mayak_members set avatar_icon=$1 where id=$2',['dog',owner]));
  await as(owner);
  assert.deepEqual(await visible(),[first]); // чужую незавершённую загрузку не видим
  assert.equal((await remove(first)).rows.length,0);
  await assert.rejects(profile('Кэп',null,first)); // даже владелец не присваивает чужое фото
  await as(outsider); assert.deepEqual(await visible(),[]);
  await assert.rejects(upload(outsider+'/'+'c'.repeat(24)+'.jpg'));
  await assert.rejects(profile('Посторонний','fox'));
  await as(guest); await profile('Гость',null,second);
  assert.equal((await remove(first)).rows.length,1); // прежнее фото теперь можно удалить
  await profile('Гость','heart'); assert.equal((await remove(second)).rows.length,1);
  assert.equal((await profile('Гость')).avatar_icon,null); // возврат к буквам
  await db.query("select public.mayak_profile('Новое имя')"); // старый клиент работает
  await db.exec('reset role; set role anon;');
  await assert.rejects(profile('Никто','cat')); assert.deepEqual(await visible(),[]);
 } finally {await db.close();}
});

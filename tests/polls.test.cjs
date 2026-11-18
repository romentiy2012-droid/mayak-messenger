const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
test('polls: private ballots, atomic choices, replay protection and chat-scoped moderation',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
   create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,version text not null default gen_random_uuid()::text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),metadata jsonb default '{}',unique(bucket_id,name));
   create function storage.foldername(text) returns text[] language sql as $$select array[split_part($1,'/',1)]$$;
   alter table storage.objects enable row level security;grant usage on schema storage to authenticated,anon;grant select,insert,update,delete on storage.objects to authenticated,anon;`);
  for(const file of fs.readdirSync('supabase/migrations').sort())await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
  const [owner,alice,bob,outside]=['1','2','3','4'].map(n=>'00000000-0000-4000-8000-00000000000'+n);
  await db.query('insert into auth.users values($1),($2),($3),($4)',[owner,alice,bob,outside]);
  await db.query("insert into mayak_members(id,name,owner) values($1,'Кэп',true),($2,'Алиса',false),($3,'Боб',false)",[owner,alice,bob]);
  const as=id=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated;`);
  const admin=()=>db.exec('reset role;');
  const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
  const get=async(id,voters=false)=>(await one('select mayak_poll_get($1,$2) r',[id,voters])).r;
  const create=async(nonce,over={})=>{const b={question:'Когда встречаемся?',options:['Утром','Вечером'],multiple:false,anonymous:true,peer:null,reply:null,...over};return (await one('select mayak_poll_create($1,$2,$3,$4,$5,$6,$7) r',[b.question,b.options,b.multiple,b.anonymous,nonce,b.peer,b.reply])).r;};
  const vote=async(id,choices,nonce)=>(await one('select mayak_poll_vote($1,$2,$3) r',[id,choices,nonce])).r;
  const close=async id=>(await one('select mayak_poll_close($1) r',[id])).r;
  const age=async()=>{await admin();await db.exec("update mayak_messages set created=now()-interval '2 seconds'");};
  await as(alice);const first=await create('anonymous'),id=first.message.id;
  assert.equal(first.message.kind,'poll');assert.equal(first.message.file,null);assert.equal(first.message.file_meta.total,0);assert.deepEqual(first.mine,[]);
  assert.equal((await create('anonymous')).message.id,id);
  for(const over of [{question:'Другой вопрос'},{options:['Днём','Ночью']},{multiple:true},{anonymous:false},{peer:bob}])await assert.rejects(create('anonymous',over));
  for(const over of [{options:['Один']},{options:['Один',' один ']},{options:['','Два']},{options:[null,'Два']},{options:Array.from({length:11},(_,i)=>String(i))},{question:' '.repeat(3)},{question:'q'.repeat(301)},{options:['x'.repeat(101),'Два']},{multiple:null}])await assert.rejects(create('bad',over));
  await assert.rejects(db.query('select mayak_edit($1,$2)',[id,'Подменить вопрос']));
  await assert.rejects(db.query('select * from mayak_private.poll_votes'));
  await assert.rejects(db.query('select mayak_private.poll_refresh($1)',[id]));
  await assert.rejects(get(id,true)); // даже автор не получает имена анонимного опроса
  await as(bob);let result=await vote(id,[1],'b-one');assert.deepEqual(result.mine,[1]);assert.equal(result.message.file_meta.total,1);
  const rev=result.message.rev;assert.equal((await vote(id,[1],'b-one')).message.rev,rev);assert.equal((await vote(id,[1,1],'b-same')).message.rev,rev);
  assert.equal(JSON.stringify(result.message.file_meta).includes(bob),false);assert.equal(JSON.stringify(result.message.file_meta).includes('mine'),false);
  assert.equal(result.voters,null);assert.equal(result.can_close,false);
  await assert.rejects(vote(id,[1,2],'many'));await assert.rejects(vote(id,[3],'missing'));await assert.rejects(vote(id,[null],'null'));await assert.rejects(vote(id,[[1]],'nested'));
  result=await vote(id,[2],'b-two');assert.deepEqual(result.message.file_meta.options.map(o=>o.count),[0,1]);
  assert.deepEqual((await vote(id,[1],'b-one')).mine,[2]); // поздний повтор старого запроса не откатывает голос
  await assert.rejects(vote(id,[1],'b-two'));
  result=await vote(id,[],'b-clear');assert.equal(result.message.file_meta.total,0);assert.deepEqual(result.mine,[]);
  await as(alice);await vote(id,[1],'a-one');await as(bob);result=await vote(id,[2],'b-three');assert.equal(result.message.file_meta.total,2);
  await assert.rejects(close(id));await as(outside);await assert.rejects(get(id));await assert.rejects(vote(id,[1],'outside'));await assert.rejects(create('outside'));
  await db.exec('reset role;set role anon;');await assert.rejects(get(id));await assert.rejects(close(id));
  await as(owner);result=await close(id);assert.ok(result.message.file_meta.closed_at);assert.equal((await close(id)).message.rev,result.message.rev);
  await as(bob);assert.deepEqual((await vote(id,[2],'b-three')).mine,[2]);await assert.rejects(vote(id,[1],'closed'));await assert.rejects(vote(id,[],'closed-clear'));
  await age();await as(alice);const open=await create('multiple',{multiple:true,anonymous:false});
  await vote(open.message.id,[1,2],'multi-a');await as(bob);result=await vote(open.message.id,[2],'multi-b');assert.equal(result.message.file_meta.total,2);assert.deepEqual(result.message.file_meta.options.map(o=>o.count),[1,2]);
  const names=(await get(open.message.id,true)).voters;assert.equal(names.length,2);assert.deepEqual(names.find(v=>v.id===alice).choices,[1,2]);assert.equal(names.find(v=>v.id===alice).name,'Алиса');
  await age();await as(alice);const direct=await create('private',{peer:bob,anonymous:false});
  assert.equal(direct.message.peer_a,alice);assert.equal(direct.message.peer_b,bob);
  await as(owner);await assert.rejects(get(direct.message.id));await assert.rejects(vote(direct.message.id,[1],'spy'));await assert.rejects(close(direct.message.id));
  assert.equal((await db.query('select id from mayak_messages where id=$1',[direct.message.id])).rows.length,0);
  await as(bob);await vote(direct.message.id,[1],'direct-b');await assert.rejects(close(direct.message.id));
  await as(alice);assert.ok((await close(direct.message.id)).message.file_meta.closed_at);
  await age();await as(owner);const authoredByOther=await create('private-to-alice',{peer:alice});
  await as(alice);await assert.rejects(close(authoredByOther.message.id));
  // Обычное сообщение с тем же nonce не может стать опросом.
  await age();await as(alice);const text=await one("select (mayak_post_to(null,'Обычный текст','plain',null)).id id");await assert.rejects(create('plain'));
  assert.equal((await one('select kind from mayak_messages where id=$1',[text.id])).kind,'text');
  await age();await as(alice);const quoted=await create('quoted',{reply:text.id});await db.query('select mayak_delete($1)',[text.id]);
  assert.equal((await create('quoted',{reply:text.id})).message.id,quoted.message.id);await assert.rejects(create('quoted',{reply:999999}));
  // Ответ из чужого личного чата не попадает в публичный опрос.
  await age();await as(owner);const quote=await create('quote',{reply:direct.message.id});assert.equal(quote.message.reply_to,null);
  // Удаление сообщения делает опрос недоступным для чтения/голосования.
  await as(owner);await db.query('select mayak_delete($1)',[open.message.id]);await as(alice);await assert.rejects(get(open.message.id));await assert.rejects(vote(open.message.id,[1],'deleted'));
  // Удалённый участник не получает доступ; его прежний бюллетень сохраняет итоги.
  await admin();await db.query('delete from mayak_members where id=$1',[bob]);await as(alice);result=await get(id);assert.equal(result.message.file_meta.total,2);assert.equal((await create('private',{peer:bob,anonymous:false})).message.id,direct.message.id);await as(bob);await assert.rejects(get(id));
 }finally{await db.close();}
});

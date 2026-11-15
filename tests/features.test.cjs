const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
test('replies, edits, deletion, reactions, read marks, typing and unread badge',async()=>{
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 await db.exec(fs.readFileSync('supabase/migrations/202611160001_cloud.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/202611160002_push.sql','utf8'));
 const owner='00000000-0000-4000-8000-000000000001',guest='00000000-0000-4000-8000-000000000002',outsider='00000000-0000-4000-8000-000000000003';
 await db.exec(`insert into auth.users values('${owner}'),('${guest}'),('${outsider}'); insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner-code','UTF8')),'hex'),true);`);
 async function as(id){await db.exec(`reset role; select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`)}
 const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
 const pause=()=>new Promise(resolve=>setTimeout(resolve,600));
 await as(owner);
 await db.query("select public.mayak_redeem('owner-code','Кэп')");
 const invite=(await one('select public.mayak_invite() as token')).token;
 // Сообщение, написанное до обновления: после миграции оно считается прочитанным и получает rev.
 const old=(await one("select (public.mayak_send('Старое','old')).id as id")).id;
 await db.exec('reset role;');
 await db.exec(fs.readFileSync('supabase/migrations/202611160003_features.sql','utf8'));
 assert.equal((await one('select rev::int as rev from public.mayak_messages where id=$1',[old])).rev,Number(old));
 assert.equal((await one('select last_read::int as n from public.mayak_members where id=$1',[owner])).n,Number(old));

 await as(guest);
 await db.query('select public.mayak_redeem($1,$2)',[invite,'Гость']);
 await db.query("select public.mayak_push_subscribe($1,$2,$3)",['https://push.example/guest','B'+'a'.repeat(86),'b'.repeat(22)]);
 await as(owner);
 await pause();
 const first=await one("select (m).id::int as id,(m).rev::int as rev,(m).reply_to::int as reply from public.mayak_post('Привет','n1',$1) m",[old]);
 assert.equal(first.reply,Number(old));assert.ok(first.rev>Number(old));
 // Повтор с тем же nonce не создаёт второе сообщение; старый вызов без ответа работает.
 assert.equal((await one("select (public.mayak_post('Привет','n1',null)).id::int as id")).id,first.id);
 await pause();
 const second=(await one("select (public.mayak_send('Второе','n2')).id::int as id")).id;
 assert.equal((await one('select last_read::int as n from public.mayak_members where id=$1',[owner])).n,second);

 // Гость: не может менять и удалять чужое, но может поставить реакцию.
 await as(guest);
 await assert.rejects(db.query("select public.mayak_edit($1,'Взлом')",[first.id]));
 await assert.rejects(db.query('select public.mayak_delete($1)',[first.id]));
 await assert.rejects(db.query("update public.mayak_messages set text='Взлом'"));
 const reacted=await one("select (m).reactions as reactions,(m).rev::int as rev from public.mayak_react($1,'👍') m",[first.id]);
 assert.deepEqual(reacted.reactions,{[guest]:'👍'});assert.ok(reacted.rev>first.rev);
 await db.query("select public.mayak_react($1,'❤️')",[first.id]);
 assert.deepEqual((await one('select reactions from public.mayak_messages where id=$1',[first.id])).reactions,{[guest]:'❤️'});
 await db.query('select public.mayak_react($1,null)',[first.id]);
 assert.deepEqual((await one('select reactions from public.mayak_messages where id=$1',[first.id])).reactions,{});
 await assert.rejects(db.query("select public.mayak_react($1,$2)",[first.id,'x'.repeat(17)]));

 // Значок непрочитанных у гостя — два сообщения; после прочтения — ноль.
 await db.exec('reset role; set role service_role;');
 const job=(await one('select public.mayak_push_claim($1) as job',[second])).job;
 assert.deepEqual(job.subscriptions.map(item=>item.badge),[2]);
 await as(guest);
 await db.query('select public.mayak_read($1)',[999999]);
 assert.equal((await one('select last_read::int as n from public.mayak_members where id=$1',[guest])).n,second);
 await db.query('select public.mayak_read($1)',[first.id]); // назад отметка не двигается
 assert.equal((await one('select last_read::int as n from public.mayak_members where id=$1',[guest])).n,second);
 await db.query('select public.mayak_typing(true)');
 assert.ok((await one('select typing from public.mayak_members where id=$1',[guest])).typing);
 await db.query('select public.mayak_typing(false)');
 assert.equal((await one('select typing from public.mayak_members where id=$1',[guest])).typing,null);

 // Автор меняет и удаляет своё; отметка о push не меняет rev.
 await as(owner);
 const edited=await one("select (m).text as text,(m).edited as edited,(m).rev::int as rev from public.mayak_edit($1,' Здравствуй ') m",[first.id]);
 assert.equal(edited.text,'Здравствуй');assert.ok(edited.edited);assert.ok(edited.rev>reacted.rev);
 await assert.rejects(db.query("select public.mayak_edit($1,'  ')",[first.id]));
 const removed=await one('select (m).text as text,(m).deleted as deleted,(m).rev::int as rev from public.mayak_delete($1) m',[first.id]);
 assert.equal(removed.text,'');assert.ok(removed.deleted);assert.ok(removed.rev>edited.rev);
 await assert.rejects(db.query("select public.mayak_edit($1,'Снова')",[first.id]));
 await assert.rejects(db.query("select public.mayak_react($1,'👍')",[first.id]));
 await db.exec('reset role;');
 const before=(await one('select rev::int as rev from public.mayak_messages where id=$1',[second])).rev;
 await db.query('update public.mayak_messages set pushed=now() where id=$1',[second]);
 assert.equal((await one('select rev::int as rev from public.mayak_messages where id=$1',[second])).rev,before);

 // Посторонний и аноним не могут ничего.
 await as(outsider);
 await assert.rejects(db.query("select public.mayak_post('no','x',null)"));
 await assert.rejects(db.query("select public.mayak_react($1,'👍')",[second]));
 await db.exec('reset role; set role anon;');
 await assert.rejects(db.query("select public.mayak_post('no','x',null)"));
 await assert.rejects(db.query('select public.mayak_read(1)'));
 await db.close();
});

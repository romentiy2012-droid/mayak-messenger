const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
test('direct chats are private to two members; read marks, typing, heard and push follow the chat',async()=>{
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 for(const file of fs.readdirSync('supabase/migrations').sort()) await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 const owner='00000000-0000-4000-8000-000000000001',kate='00000000-0000-4000-8000-000000000002',third='00000000-0000-4000-8000-000000000003',outsider='00000000-0000-4000-8000-000000000004';
 await db.exec(`insert into auth.users values('${owner}'),('${kate}'),('${third}'),('${outsider}'); insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner-code','UTF8')),'hex'),true);`);
 const as=async id=>db.exec(`reset role; select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`);
 const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
 const ids=async()=>(await db.query('select id::int as id from public.mayak_messages order by id')).rows.map(row=>row.id);
 const pause=()=>new Promise(resolve=>setTimeout(resolve,600));
 const join=async(id,name)=>{await as(owner);const token=(await one('select public.mayak_invite() as token')).token;await as(id);await db.query('select public.mayak_redeem($1,$2)',[token,name]);};
 const post=async(peer,text,nonce,reply=null)=>{await pause();return one('select (m).id::int as id,(m).peer_a as a,(m).peer_b as b,(m).reply_to::int as reply from public.mayak_post_to($1,$2,$3,$4) m',[peer,text,nonce,reply]);};
 await as(owner);await db.query("select public.mayak_redeem('owner-code','Кэп')");
 await join(kate,'Катя');await join(third,'Третий');
 const sub=async name=>db.query('select public.mayak_push_subscribe($1,$2,$3)',['https://push.example/'+name,'B'+'a'.repeat(86),'b'.repeat(22)]);
 await as(kate);await sub('kate');await as(third);await sub('third');

 await as(owner);
 const common=await post(null,'Всем привет','c1');
 assert.equal(common.a,null);
 const direct=await post(kate,'Катя, только тебе','d1',common.id);
 assert.deepEqual([direct.a,direct.b],[owner,kate]);assert.equal(direct.reply,null); // ответ на сообщение из другого чата не привязывается
 await assert.rejects(post(owner,'Себе','d2'));
 await assert.rejects(post(outsider,'Чужому','d3'));
 // Старый вызов пишет в общий чат.
 await pause();assert.equal((await one("select (m).peer_a as a from public.mayak_post('По-старому','c2',null) m")).a,null);

 // Видимость: третий участник личного не видит и ничего с ним сделать не может.
 await as(third);
 assert.equal((await ids()).includes(direct.id),false);
 await assert.rejects(db.query("select public.mayak_react($1,'👍')",[direct.id]));
 assert.equal((await one('select (public.mayak_heard($1)).id as id',[direct.id])).id,null); // чужое личное не выдаётся
 assert.equal((await db.query('select * from public.mayak_reads')).rows.length,0);
 await as(kate);
 assert.equal((await ids()).includes(direct.id),true);
 const answer=await post(owner,'Поняла','d4',direct.id);
 assert.deepEqual([answer.a,answer.b,answer.reply],[owner,kate,direct.id]);
 await db.query("select public.mayak_react($1,'❤️')",[direct.id]);

 // Прочитано в личном чате не трогает общий, и наоборот.
 const before=(await one('select last_read::int as n from public.mayak_members where id=$1',[kate])).n;
 await db.query('select public.mayak_read_to($1,$2)',[owner,999999]);
 assert.equal((await one('select last_read::int as n from public.mayak_reads where user_id=$1 and peer=$2',[kate,owner])).n,answer.id);
 assert.equal((await one('select last_read::int as n from public.mayak_members where id=$1',[kate])).n,before);
 await db.query('select public.mayak_read_to($1,$2)',[owner,1]); // назад не двигается
 assert.equal((await one('select last_read::int as n from public.mayak_reads where user_id=$1 and peer=$2',[kate,owner])).n,answer.id);
 await db.query('select public.mayak_typing_to($1,true)',[owner]);
 assert.ok((await one('select typing from public.mayak_reads where user_id=$1 and peer=$2',[kate,owner])).typing);
 assert.equal((await one('select typing from public.mayak_members where id=$1',[kate])).typing,null); // в общем чате «печатает» не появляется
 await as(owner);
 assert.equal((await db.query('select * from public.mayak_reads')).rows.length,2); // своя строка и строка собеседника
 await assert.rejects(db.query('update public.mayak_reads set last_read=0'));
 // Владелец удаляет чужое в общем чате, но не в личном.
 await assert.rejects(db.query('select public.mayak_delete($1)',[answer.id]));
 await as(kate);await db.query('select public.mayak_delete($1)',[answer.id]);

 // Голосовое в личном чате: «прослушано» ставит собеседник, автору приходит новый rev.
 await as(owner);await pause();
 const voice=await one('select (m).id::int as id,(m).rev::int as rev,(m).peer_b as b from public.mayak_attach_to($1,$2,$3,$4,$5,$6,$7) m',[kate,'voice',owner+'/voiceABCDEFGH.m4a','{"duration":3}','','v1',null]);
 assert.equal(voice.b,kate);
 assert.deepEqual((await one('select (public.mayak_heard($1)).heard as heard',[voice.id])).heard,[]); // автор сам себе не засчитывается
 await as(kate);
 const heard=await one('select (m).heard as heard,(m).rev::int as rev from public.mayak_heard($1) m',[voice.id]);
 assert.deepEqual(heard.heard,[kate]);assert.ok(heard.rev>voice.rev);
 assert.equal((await one('select (m).rev::int as rev from public.mayak_heard($1) m',[voice.id])).rev,heard.rev); // повторно не считается

 // Уведомления: личное — только собеседнику, с пометкой; значок считает общий и личный чаты.
 await db.exec('reset role; set role service_role;');
 const job=(await one('select public.mayak_push_claim($1) as job',[voice.id])).job;
 assert.equal(job.title,'Кэп · лично');
 assert.deepEqual(job.subscriptions.map(item=>item.endpoint),['https://push.example/kate']);
 assert.equal(job.subscriptions[0].badge,3); // два общих сообщения владельца и голосовое; прочитанное личное не в счёт
 const commonJob=(await one('select public.mayak_push_claim($1) as job',[common.id])).job;
 assert.equal(commonJob.title,'Кэп');
 assert.deepEqual(commonJob.subscriptions.map(item=>item.endpoint).sort(),['https://push.example/kate','https://push.example/third']);
 assert.equal(commonJob.subscriptions.find(item=>item.endpoint.endsWith('third')).badge,2);

 // Удаление участника: личная переписка остаётся у второго и не становится общей.
 await as(owner);await db.query('select public.mayak_kick($1)',[kate]);
 assert.equal((await ids()).includes(direct.id),true);
 await as(third);
 assert.equal((await ids()).includes(direct.id),false);
 await as(outsider);
 assert.equal((await ids()).length,0);
 await assert.rejects(post(owner,'Чужой','o1'));
 await db.exec('reset role; set role anon;');
 await assert.rejects(db.query('select * from public.mayak_reads'));
 await assert.rejects(db.query("select public.mayak_post_to(null,'x','n',null)"));
 await db.close();
});

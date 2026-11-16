const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
test('owner can delete any message and remove a member; others cannot',async()=>{
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 for(const file of fs.readdirSync('supabase/migrations').sort()) await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 const owner='00000000-0000-4000-8000-000000000001',guest='00000000-0000-4000-8000-000000000002',third='00000000-0000-4000-8000-000000000003';
 await db.exec(`insert into auth.users values('${owner}'),('${guest}'),('${third}'); insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner-code','UTF8')),'hex'),true);`);
 const as=async id=>db.exec(`reset role; select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`);
 const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
 const pause=()=>new Promise(resolve=>setTimeout(resolve,600));
 const join=async(id,name)=>{await as(owner);const token=(await one('select public.mayak_invite() as token')).token;await as(id);await db.query('select public.mayak_redeem($1,$2)',[token,name]);};
 await as(owner);await db.query("select public.mayak_redeem('owner-code','Кэп')");
 await join(guest,'Гость');await join(third,'Третий');
 await as(guest);
 const mine=(await one("select (public.mayak_post('От гостя','g1',null)).id::int as id")).id;
 await db.query('select public.mayak_push_subscribe($1,$2,$3)',['https://push.example/guest','B'+'a'.repeat(86),'b'.repeat(22)]);
 await as(owner);
 const ownerMessage=(await one("select (public.mayak_post('От владельца','o1',null)).id::int as id")).id;
 const resetToken=(await one('select public.mayak_reset_issue($1) as token',[guest])).token;

 // Обычный участник чужое не удаляет и никого не выгоняет.
 await as(third);
 await assert.rejects(db.query('select public.mayak_delete($1)',[mine]));
 await assert.rejects(db.query('select public.mayak_kick($1)',[guest]));
 await assert.rejects(db.query('select public.mayak_kick($1)',[owner]));
 // Владелец удаляет чужое сообщение.
 await as(owner);
 const removed=await one('select (m).deleted as deleted,(m).text as text,(m).user_id as author from public.mayak_delete($1) m',[mine]);
 assert.ok(removed.deleted);assert.equal(removed.text,'');assert.equal(removed.author,guest);
 await assert.rejects(db.query('select public.mayak_delete($1)',[mine])); // уже удалено
 // Себя и несуществующего удалить нельзя.
 await assert.rejects(db.query('select public.mayak_kick($1)',[owner]));
 await assert.rejects(db.query('select public.mayak_kick($1)',['00000000-0000-4000-8000-00000000000f']));

 // Владелец удаляет участника: доступ, подписки и ссылка сброса пропадают, сообщения остаются.
 await as(guest);await pause();
 const kept=(await one("select (public.mayak_post('Останется в истории','g2',null)).id::int as id")).id;
 await as(owner);
 await db.query('select public.mayak_kick($1)',[guest]);
 const history=await one('select name,text,user_id from public.mayak_messages where id=$1',[kept]);
 assert.deepEqual(history,{name:'Гость',text:'Останется в истории',user_id:null});
 assert.equal((await db.query('select 1 from public.mayak_members')).rows.length,2);
 await db.exec('reset role;');
 assert.equal((await db.query('select 1 from mayak_private.push_subscriptions')).rows.length,0);
 assert.equal((await db.query('select 1 from mayak_private.resets')).rows.length,0);
 assert.equal((await db.query('select 1 from auth.users where id=$1',[guest])).rows.length,0);
 await db.exec('set role service_role;');
 assert.equal((await one('select public.mayak_reset_check($1) as id',[resetToken])).id,null);
 // Удалённый больше ничего не видит и не пишет.
 await db.exec(`reset role; insert into auth.users values('${guest}');`);
 await as(guest);
 assert.equal((await db.query('select * from public.mayak_messages')).rows.length,0);
 await assert.rejects(db.query("select public.mayak_post('Я вернулся','g3',null)"));
 await assert.rejects(db.query('select public.mayak_delete($1)',[kept]));
 await assert.rejects(db.query("select public.mayak_react($1,'👍')",[ownerMessage]));
 // Вернуться можно по новому приглашению.
 await join(guest,'Гость снова');
 assert.equal((await db.query('select * from public.mayak_messages')).rows.length,3);
 await db.exec('reset role; set role anon;');
 await assert.rejects(db.query('select public.mayak_kick($1)',[third]));
 await db.close();
});

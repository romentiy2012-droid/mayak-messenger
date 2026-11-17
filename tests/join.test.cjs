const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
test('a new member gets a system line in the main chat; the owner does not; it never pushes or counts as unread',async()=>{
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 for(const file of fs.readdirSync('supabase/migrations').sort()) await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 const owner='00000000-0000-4000-8000-000000000001',kate='00000000-0000-4000-8000-000000000002',third='00000000-0000-4000-8000-000000000003';
 await db.exec(`insert into auth.users values('${owner}'),('${kate}'),('${third}'); insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner-code','UTF8')),'hex'),true);`);
 const as=async id=>db.exec(`reset role; select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`);
 const system=async()=>(await db.query("select id::int as id,user_id,name,text,kind,peer_a from public.mayak_messages where kind='system' order by id")).rows;
 const join=async(id,name)=>{await as(owner);const token=(await db.query('select public.mayak_invite() as token')).rows[0].token;await as(id);await db.query('select public.mayak_redeem($1,$2)',[token,name]);};

 await as(owner);await db.query("select public.mayak_redeem('owner-code','Кэп')");
 assert.equal((await system()).length,0); // у владельца при первом входе строки нет
 await join(kate,'Катя');
 let lines=await system();
 assert.equal(lines.length,1);
 assert.deepEqual([lines[0].user_id,lines[0].name,lines[0].text,lines[0].kind,lines[0].peer_a],[null,'Катя','Катя добавлен в чат','system',null]);
 await join(third,'Третий');
 await as(kate);
 assert.deepEqual((await system()).map(row=>row.name),['Катя','Третий']); // видят все участники
 // Повторный вход уже существующего участника строку не дублирует.
 await db.query("select public.mayak_redeem('whatever','Катя')");
 assert.equal((await system()).length,2);
 // Участник не может подделать служебную строку: прямой записи в таблицу нет, а через отправку вид всегда «text».
 await assert.rejects(db.query("insert into public.mayak_messages(user_id,name,text,nonce,kind) values($1,'Катя','фальшивка','x1','system')",[kate]));
 // Уведомление по служебной строке не отправляется, а метка «отправлено» ставится сразу.
 await db.exec('reset role;');
 const id=(await system())[0].id;
 await db.exec('set role service_role;');
 assert.equal((await db.query('select public.mayak_push_claim($1) as job',[id])).rows[0].job,null);
 await db.exec('reset role;');
 assert.notEqual((await db.query('select pushed from public.mayak_messages where id=$1',[id])).rows[0].pushed,null);
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');

async function load(name){
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'mayak-fn-')),name+'.mjs');
 fs.copyFileSync('supabase/functions/'+name+'/index.ts',file);
 return import(require('node:url').pathToFileURL(file).href);
}
async function database(){
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 for(const file of ['202611160001_cloud.sql','202611160002_push.sql','202611160003_features.sql','202611160004_reliability.sql']) await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 return db;
}
const owner='00000000-0000-4000-8000-000000000001',guest='00000000-0000-4000-8000-000000000002',outsider='00000000-0000-4000-8000-000000000003';
async function people(db){
 await db.exec(`insert into auth.users values('${owner}'),('${guest}'),('${outsider}'); insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner-code','UTF8')),'hex'),true);`);
 const as=async id=>db.exec(`reset role; select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`);
 await as(owner);
 await db.query("select public.mayak_redeem('owner-code','Кэп')");
 const invite=(await db.query('select public.mayak_invite() as token')).rows[0].token;
 await as(guest);
 await db.query('select public.mayak_redeem($1,$2)',[invite,'Гость']);
 return as;
}
const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];

test('password reset: only the owner issues a one-time code, only the service consumes it',async()=>{
 const db=await database();const as=await people(db);
 await as(guest);
 await assert.rejects(db.query('select public.mayak_reset_issue($1)',[guest]));
 await assert.rejects(db.query("select public.mayak_reset_check('x')"));
 await assert.rejects(db.query('select * from mayak_private.resets'));
 await as(outsider);
 await assert.rejects(db.query('select public.mayak_reset_issue($1)',[guest]));
 await as(owner);
 await assert.rejects(db.query('select public.mayak_reset_issue($1)',[outsider])); // не участник
 const first=(await one(db,'select public.mayak_reset_issue($1) as token',[guest])).token;
 const token=(await one(db,'select public.mayak_reset_issue($1) as token',[guest])).token;
 assert.match(token,/^[0-9a-f]{64}$/);assert.notEqual(first,token);
 await assert.rejects(db.query('select public.mayak_reset_check($1)',[token]));
 await db.exec('reset role;');
 assert.equal((await one(db,'select token_hash from mayak_private.resets')).token_hash,crypto.createHash('sha256').update(token).digest('hex'));
 await db.exec('set role service_role;');
 assert.equal((await one(db,'select public.mayak_reset_check($1) as id',[first])).id,null); // прежняя ссылка отменена
 assert.equal((await one(db,'select public.mayak_reset_check($1) as id',[token])).id,guest);
 await db.query('select public.mayak_reset_done($1)',[token]);
 assert.equal((await one(db,'select public.mayak_reset_check($1) as id',[token])).id,null);
 // Просроченная ссылка не работает.
 await as(owner);
 const stale=(await one(db,'select public.mayak_reset_issue($1) as token',[guest])).token;
 await db.exec("reset role; update mayak_private.resets set expires=now()-interval '1 minute'; set role service_role;");
 assert.equal((await one(db,'select public.mayak_reset_check($1) as id',[stale])).id,null);
 await db.exec('reset role; set role anon;');
 await assert.rejects(db.query('select public.mayak_reset_issue($1)',[guest]));
 await assert.rejects(db.query('select public.mayak_reset_check($1)',[stale]));
 await db.close();
});

test('push retry: a message stays unsent until every subscription answered',async()=>{
 const db=await database();const as=await people(db);
 const p256dh='B'+'a'.repeat(86),auth='b'.repeat(22);
 await as(owner);
 for(const name of ['a','b','c']) await db.query('select public.mayak_push_subscribe($1,$2,$3)',['https://push.example/'+name,p256dh,auth]);
 await as(guest);
 const id=(await one(db,"select (public.mayak_post('Привет','n1',null)).id::int as id")).id;
 await db.exec('reset role; set role service_role;');
 const claim=async()=>(await one(db,'select public.mayak_push_claim($1) as job',[id])).job;
 const state=async()=>{await db.exec('reset role;');const row=await one(db,'select pushed,push_tries::int as tries,push_pending as pending,rev::int as rev from public.mayak_messages where id=$1',[id]);await db.exec('set role service_role;');return row;};
 const later=async()=>{await db.exec("reset role; update public.mayak_messages set push_at=now()-interval '1 minute'; set role service_role;");};
 const rev=(await state()).rev;
 const job=await claim();
 assert.deepEqual(job.subscriptions.map(item=>item.endpoint).sort(),['https://push.example/a','https://push.example/b','https://push.example/c']);
 assert.equal(await claim(),null); // вторая попытка сразу — нельзя
 // a доставлено, b исчезла, c временно недоступна.
 await db.query('select public.mayak_push_result($1,$2,$3)',[id,['https://push.example/c'],['https://push.example/b']]);
 let row=await state();
 assert.equal(row.pushed,null);assert.deepEqual(row.pending,['https://push.example/c']);assert.equal(row.tries,1);
 assert.equal(await claim(),null); // 20 секунд ещё не прошло
 await later();
 assert.deepEqual((await claim()).subscriptions.map(item=>item.endpoint),['https://push.example/c']); // повтор только по несостоявшейся
 await db.query('select public.mayak_push_result($1,$2,$3)',[id,[],[]]);
 row=await state();
 assert.ok(row.pushed);assert.equal(row.pending,null);assert.equal(row.rev,rev); // служебные отметки не меняют rev
 await later();assert.equal(await claim(),null);
 // Не больше шести попыток.
 await as(guest);
 await new Promise(resolve=>setTimeout(resolve,600));
 const second=(await one(db,"select (public.mayak_post('Ещё','n2',null)).id::int as id")).id;
 await db.exec('reset role; set role service_role;');
 for(let i=0;i<6;i++){assert.ok((await one(db,'select public.mayak_push_claim($1) as job',[second])).job);await db.query('select public.mayak_push_result($1,$2,$3)',[second,['https://push.example/a'],[]]);await later();}
 assert.equal((await one(db,'select public.mayak_push_claim($1) as job',[second])).job,null);
 // Некому отправлять — сообщение сразу считается обработанным.
 await db.exec("reset role; delete from mayak_private.push_subscriptions;");
 await as(guest);
 await new Promise(resolve=>setTimeout(resolve,600));
 const third=(await one(db,"select (public.mayak_post('Третье','n3',null)).id::int as id")).id;
 await db.exec('reset role; set role service_role;');
 assert.equal((await one(db,'select public.mayak_push_claim($1) as job',[third])).job,null);
 await db.exec('reset role;');
 assert.ok((await one(db,'select pushed from public.mayak_messages where id=$1',[third])).pushed);
 await db.exec('set role authenticated;');
 await assert.rejects(db.query('select public.mayak_push_result($1,$2,$3)',[id,[],[]]));
 await db.close();
});

test('push function retries temporary failures and reports the rest to the database',async()=>{
 const push=await load('push');
 const browser=crypto.createECDH('prime256v1');browser.generateKeys();
 const keys={p256dh:browser.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')};
 const server=crypto.createECDH('prime256v1');server.generateKeys();
 const calls={},rpc=[];
 // ok — сразу 201; flaky — 503, потом 201; down — всегда 500; gone — 410; bad — 400; offline — сеть недоступна.
 const answers={ok:[201],flaky:[503,201],down:[500,500,500],gone:[410],bad:[400],offline:['throw','throw','throw']};
 const originalFetch=globalThis.fetch,originalDeno=globalThis.Deno;
 globalThis.Deno={env:{get:name=>({SUPABASE_URL:'https://db.example',SUPABASE_SERVICE_ROLE_KEY:'service',VAPID_PRIVATE_KEY:server.getPrivateKey().toString('base64url'),VAPID_PUBLIC_KEY:server.getPublicKey().toString('base64url')})[name]}};
 globalThis.fetch=async(url,init)=>{
  url=String(url);
  if(url.startsWith('https://db.example/rest/v1/rpc/')){
   const name=url.split('/').pop(),args=JSON.parse(init.body);rpc.push([name,args]);
   if(name==='mayak_push_claim') return new Response(JSON.stringify({id:7,title:'Гость',body:'Привет',vapid:null,subscriptions:Object.keys(answers).map((key,index)=>({endpoint:'https://push.example/'+key,badge:index,...keys}))}));
   return new Response('');
  }
  const key=url.split('/').pop();calls[key]=(calls[key]||0)+1;
  const answer=answers[key][calls[key]-1];
  if(answer==='throw') throw new TypeError('network');
  return new Response(null,{status:answer});
 };
 try{
  const result=await push.deliver(7,[1,1]);
  assert.deepEqual({sent:result.sent,removed:result.removed,retry:result.retry},{sent:2,removed:1,retry:2});
  assert.deepEqual(result.failed,['push.example failed 400']);
  assert.deepEqual(calls,{ok:1,flaky:2,down:3,gone:1,bad:1,offline:3});
  const report=rpc.find(item=>item[0]==='mayak_push_result')[1];
  assert.equal(report.p_id,7);
  assert.deepEqual(report.p_failed.sort(),['https://push.example/down','https://push.example/offline']);
  assert.deepEqual(report.p_gone,['https://push.example/gone']);
  // Неверный ключ — не временный сбой: повторять бессмысленно.
  globalThis.Deno.env.get=name=>({SUPABASE_URL:'https://db.example',SUPABASE_SERVICE_ROLE_KEY:'service',VAPID_PRIVATE_KEY:server.getPrivateKey().toString('base64url')})[name];
  const wrong=await push.deliver(7,[1,1]);
  assert.equal(wrong.retry,0);assert.equal(wrong.failed.length,6);
 }finally{globalThis.fetch=originalFetch;if(originalDeno===undefined)delete globalThis.Deno;else globalThis.Deno=originalDeno;}
});

test('reset function: validates input, changes the password once, hides details',async()=>{
 const reset=await load('reset');
 const token='a'.repeat(64),requests=[];
 let valid=true,authStatus=200;
 const originalFetch=globalThis.fetch,originalDeno=globalThis.Deno;
 globalThis.Deno={env:{get:name=>({SUPABASE_URL:'https://db.example',SUPABASE_SERVICE_ROLE_KEY:'service'})[name]}};
 globalThis.fetch=async(url,init)=>{
  url=String(url);requests.push([init.method,url.replace('https://db.example',''),JSON.parse(init.body)]);
  assert.equal(init.headers.Authorization,'Bearer service');
  if(url.endsWith('/mayak_reset_check')) return new Response(JSON.stringify(valid?guest:null));
  if(url.includes('/auth/v1/admin/users/')) return new Response(JSON.stringify(authStatus===200?{id:guest,email:'u_d0b3@mayak.app'}:{msg:'weak'}),{status:authStatus});
  return new Response('');
 };
 const call=async(body,method='POST')=>{const response=await reset.handler(new Request('https://fn.example/reset',{method,body:method==='POST'?JSON.stringify(body):undefined}));return {status:response.status,cors:response.headers.get('access-control-allow-origin'),body:response.status===204?null:await response.json()};};
 try{
  assert.deepEqual(await call(null,'OPTIONS'),{status:204,cors:'*',body:null});
  assert.equal((await call({},'GET')).status,405);
  assert.equal((await call({token:'short',password:'longenough'})).status,400);
  assert.equal((await call({token,password:'short'})).status,400);
  assert.equal(requests.length,0); // до базы дело не дошло
  const done=await call({token,password:'new-password'});
  assert.deepEqual(done,{status:200,cors:'*',body:{email:'u_d0b3@mayak.app'}});
  assert.deepEqual(requests.map(item=>item[0]+' '+item[1]),['POST /rest/v1/rpc/mayak_reset_check','PUT /auth/v1/admin/users/'+guest,'POST /rest/v1/rpc/mayak_reset_done']);
  assert.deepEqual(requests[1][2],{password:'new-password'});
  // Код не подошёл — пароль не трогаем.
  requests.length=0;valid=false;
  assert.equal((await call({token,password:'new-password'})).status,400);
  assert.equal(requests.length,1);
  // Слабый пароль — код остаётся действительным.
  requests.length=0;valid=true;authStatus=422;
  assert.equal((await call({token,password:'new-password'})).status,400);
  assert.equal(requests.some(item=>item[1].endsWith('mayak_reset_done')),false);
 }finally{globalThis.fetch=originalFetch;if(originalDeno===undefined)delete globalThis.Deno;else globalThis.Deno=originalDeno;}
});

const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {transformSync}=require('esbuild');
const code=transformSync(fs.readFileSync('supabase/functions/storage-admin/index.ts','utf8'),{loader:'ts',format:'cjs',target:'node22'}).code;
const BASE='https://example.supabase.co',ORIGIN='https://romentiy2012-droid.github.io';
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const ACTOR=uuid(1),OTHER=uuid(2),OPERATION=uuid(3),NONCE='storage_retry_nonce_123456';
const USER_TOKEN='actual.user.jwt';
function setup(options={}){
 const service=options.legacy?'legacy.service.jwt':'sb_secret_test_server_only';
 const publicKey=options.legacy?'legacy.anon.jwt':'sb_publishable_test_public';
 const env={SUPABASE_URL:BASE,SUPABASE_SERVICE_ROLE_KEY:service,SUPABASE_ANON_KEY:publicKey,
  ...(options.named?{SUPABASE_SERVICE_ROLE_KEY:'unused.legacy.service',SUPABASE_ANON_KEY:'unused.legacy.anon',
   SUPABASE_SECRET_KEYS:JSON.stringify({default:service}),SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:publicKey})}:{}),...options.env};
 const requests=[],operations=new Map(),objects=new Map((options.objects||[
  {id:uuid(10),bucket:'mayak-video',path:OTHER+'/private-video.mp4',version:'version-a',bytes:1500},
  {id:uuid(11),bucket:'mayak-video-source',path:OTHER+'/private-source.webm',version:'version-b',bytes:500}
 ]).map(item=>[item.id,{...item,present:true}]));
 let deleteAttempt=0,finishAttempt=0;
 const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 const overview=()=>({storage:{used_bytes:[...objects.values()].filter(item=>item.present).reduce((sum,item)=>sum+item.bytes,0),objects_count:[...objects.values()].filter(item=>item.present).length,unknown_size_count:options.unknownSize||0},
  items:[...objects.values()].filter(item=>item.present).map(item=>({id:item.id,version:item.version,bytes:item.bytes,kind:'video',label:'Видеокружочек',scope:'direct',can_delete:true}))});
 const fetch=async(input,init={})=>{
  const url=new URL(input),body=init.body===undefined?undefined:JSON.parse(init.body);
  assert.equal(url.origin,BASE,'No credential-bearing request may leave the configured project');
  assert.equal(init.redirect,'error');
  const userRequest=url.pathname==='/auth/v1/user'||url.pathname==='/rest/v1/mayak_members';
  assert.equal(init.headers.apikey,userRequest?publicKey:service);
  assert.equal(init.headers.Authorization,userRequest?'Bearer '+USER_TOKEN:options.legacy?'Bearer '+service:undefined);
  requests.push({url:url.href,path:url.pathname,method:init.method,body,headers:{...init.headers}});
  if(url.pathname==='/auth/v1/user')return options.authFailure?json({message:'Invalid JWT '+service},401):json({id:options.authId||ACTOR});
  if(url.pathname==='/rest/v1/mayak_members'){
   assert.equal(url.searchParams.get('select'),'owner');assert.equal(url.searchParams.get('id'),'eq.'+(options.authId||ACTOR));
   return json(options.removed?[]:[{owner:options.owner!==false}]);
  }
  const action=url.pathname.replace('/rest/v1/rpc/mayak_storage_','');
  if(['overview','prepare','finish'].includes(action)){
   assert.equal(body.p_actor,options.authId||ACTOR,'Privileged RPC actor must come from verified Auth');
   if(options.rpcFailure===action)return json({code:options.rpcCode||'42P01',message:'private SQL relation failure '+service,details:'server internals'},options.rpcStatus||500);
   if(action==='overview')return json(options.overview?options.overview():overview());
   if(action==='prepare'){
    if(options.prepare)return json(options.prepare(body));
    let operation=operations.get(body.p_nonce);
    if(!operation){operation={id:OPERATION,items:body.p_items.map(item=>({...objects.get(item.id),status:'pending'}))};operations.set(body.p_nonce,operation);}
    return json(operation);
   }
   finishAttempt++;
   assert.equal(body.p_operation,OPERATION);assert.equal(typeof body.p_success,'boolean');
   if(options.finish)return json(options.finish(body));
   const status=objects.get(body.p_object)?.present?'failed':'deleted';
   for(const operation of operations.values())for(const item of operation.items)if(item.id===body.p_object)item.status=status;
   if(options.loseFinishResponse&&finishAttempt===1)throw Error('finish response lost after commit');
   return json({id:body.p_object,status});
  }
  assert.equal(init.method,'DELETE');
  assert.deepEqual(Object.keys(body),['prefixes']);assert.equal(body.prefixes.length,1);
  const object=[...objects.values()].find(item=>url.pathname==='/storage/v1/object/'+item.bucket&&body.prefixes[0]===item.path);
  assert.ok(object,'Storage target must exactly match a prepared bucket/path');
  deleteAttempt++;
  const outcome=options.deleteResult?.({object,attempt:deleteAttempt})||'deleted';
  if(outcome==='failed')return json({message:'backend error '+service},500);
  if(outcome!=='retained')object.present=false;
  if(outcome==='lost')throw Error('delete response lost after physical deletion');
  return json([{name:object.path}]);
 };
 const context={module:{exports:{}},exports:{},Deno:{env:{get:key=>env[key]},serve(){}},fetch,Request,Response,URL,AbortSignal,console:{error(){}}};
 context.module.exports=context.exports;vm.runInNewContext(code,context);
 const request=(body={action:'overview'},extra={})=>new Request(BASE+'/functions/v1/storage-admin',{
  method:'POST',headers:{Origin:ORIGIN,Authorization:'Bearer '+USER_TOKEN,...extra.headers},body:typeof body==='string'?body:JSON.stringify(body),...Object.fromEntries(Object.entries(extra).filter(([key])=>key!=='headers'))});
 const selection=()=>[...objects.values()].map(({id,version})=>({id,version}));
 return {...context.module.exports,request,requests,objects,selection,service,publicKey,overview};
}
const privileged=app=>app.requests.filter(item=>item.path.startsWith('/rest/v1/rpc/')||item.path.startsWith('/storage/v1/'));
function privateDataAbsent(body,app){
 const raw=JSON.stringify(body);
 for(const item of app.objects.values())assert.ok(!raw.includes(item.path),'Private object path must not reach the browser');
 assert.ok(!raw.includes(app.service));assert.ok(!raw.includes(BASE));
 if(body.operation)for(const item of body.operation.items)assert.deepEqual(Object.keys(item).sort(),item.status==='deleted'?['id','status']:['error','id','status']);
}

test('storage edge: verified owner, separate user JWT/API keys, and honest unavailable traffic',async()=>{
 for(const options of [{},{legacy:true},{named:true}]){
  const app=setup(options),response=await app.handle(app.request({action:'overview',p_actor:OTHER,actor:OTHER,owner:true}));
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const body=await response.json();assert.equal(body.storage.used_bytes,2000);
  assert.equal(body.traffic.status,'unavailable');
  for(const key of ['used_bytes','observed_at','period_start','period_end'])assert.equal(body.traffic[key],null);
  assert.equal(body.traffic.uncached_quota_bytes,5000000000);assert.equal(body.traffic.cached_quota_bytes,5000000000);
  const overview=privileged(app);assert.equal(overview.length,1);assert.equal(overview[0].body.p_actor,ACTOR);privateDataAbsent(body,app);
 }
 const unknown=setup({unknownSize:1}),body=await (await unknown.handle(unknown.request())).json();assert.equal(body.storage.free_bytes,null);
});

test('storage edge: unauthenticated, guest, removed member and invalid Auth identity cannot reach privileged RPC',async()=>{
 const missing=setup();assert.equal((await missing.handle(missing.request({}, {headers:{Authorization:''}}))).status,401);assert.equal(missing.requests.length,0);
 for(const options of [{owner:false},{removed:true},{authFailure:true},{authId:'not-a-uuid'}]){
  const app=setup(options),response=await app.handle(app.request({action:'delete',actor:ACTOR,owner:true,items:app.selection(),nonce:NONCE}));
  assert.equal(response.status,options.authId?401:403);assert.equal(privileged(app).length,0);assert.ok(!(await response.text()).includes(app.service));
 }
 const owner=setup({authId:OTHER});assert.equal((await owner.handle(owner.request({action:'overview',actor:ACTOR}))).status,200);
 assert.equal(privileged(owner)[0].body.p_actor,OTHER);
});

test('storage edge: CORS, methods, bounded JSON and selected object versions are checked before service operations',async()=>{
 const app=setup();
 for(const method of ['OPTIONS','GET']){
  const response=await app.handle(new Request(BASE+'/functions/v1/storage-admin',{method,headers:{Origin:ORIGIN}}));
  assert.equal(response.status,method==='OPTIONS'?204:405);
 }
 assert.equal((await app.handle(new Request(BASE+'/functions/v1/storage-admin',{method:'OPTIONS',headers:{Origin:'https://evil.example'}}))).status,403);
 assert.equal(app.requests.length,0);
 const valid={action:'delete',items:app.selection(),nonce:NONCE};
 const invalid=[null,[],{action:'unknown'},{action:'overview',filter:'sql'},{action:'overview',offset:-1},{action:'overview',offset:1.5},{action:'overview',offset:1000001},
  {...valid,items:[]},{...valid,items:Array.from({length:21},(_,i)=>({id:uuid(100+i),version:'v'}))},{...valid,items:[valid.items[0],valid.items[0]]},
  {...valid,items:[{id:'invalid',version:'v'}]},{...valid,items:[{id:uuid(10),version:''}]},{...valid,items:[{id:uuid(10),version:'x'.repeat(201)}]},
  {...valid,items:[{id:uuid(10),version:3}]},{...valid,nonce:'short'},{...valid,nonce:'x'.repeat(101)},{...valid,nonce:'https://evil.example'}];
 for(const body of invalid)assert.equal((await app.handle(app.request(body))).status,400,JSON.stringify(body));
 assert.equal((await app.handle(app.request('{'))).status,400);
 assert.equal((await app.handle(app.request(' '.repeat(12001)))).status,413);
 assert.equal(privileged(app).length,0);
});

test('storage edge: physical delete uses prepared target; HTTP success alone never proves freed bytes',async()=>{
 const app=setup({deleteResult:()=> 'retained'}),selected=app.selection().slice(0,1);
 const response=await app.handle(app.request({action:'delete',items:selected.map(item=>({...item,bucket:'evil',path:'https://evil.example/file'})),nonce:NONCE}));
 assert.equal(response.status,200);const body=await response.json();
 assert.equal(body.operation.items[0].status,'failed');assert.equal(body.storage.used_bytes,2000);privateDataAbsent(body,app);
 const prepare=app.requests.find(item=>item.path.endsWith('_prepare'));assert.deepEqual(prepare.body.p_items,selected);
 const deletion=app.requests.find(item=>item.method==='DELETE');assert.equal(deletion.path,'/storage/v1/object/mayak-video');assert.deepEqual(deletion.body,{prefixes:[OTHER+'/private-video.mp4']});
 const finish=app.requests.find(item=>item.path.endsWith('_finish'));assert.equal(finish.body.p_success,true);
});

test('storage edge: lost physical-delete response can still be confirmed by authoritative absence',async()=>{
 const app=setup({deleteResult:()=> 'lost'}),response=await app.handle(app.request({action:'delete',items:app.selection(),nonce:NONCE}));
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.storage.used_bytes,0);
 assert.ok(body.operation.items.every(item=>item.status==='deleted'));
 assert.ok(app.requests.filter(item=>item.path.endsWith('_finish')).every(item=>item.body.p_success===false));privateDataAbsent(body,app);
});

test('storage edge: partial failure and lost finish response retry the same nonce without deleting completed files twice',async()=>{
 let failed=true;
 const app=setup({loseFinishResponse:true,deleteResult:({object})=>{if(object.id===uuid(11)&&failed){failed=false;return 'failed';}return 'deleted';}});
 const body={action:'delete',items:app.selection(),nonce:NONCE};
 const first=await (await app.handle(app.request(body))).json();assert.equal(first.operation.id,OPERATION);
 assert.equal(first.storage.used_bytes,500);assert.ok(first.operation.items.every(item=>item.status==='failed'));
 const second=await (await app.handle(app.request(body))).json();assert.equal(second.operation.id,first.operation.id);assert.equal(second.storage.used_bytes,0);
 assert.ok(second.operation.items.every(item=>item.status==='deleted'));
 const prepares=app.requests.filter(item=>item.path.endsWith('_prepare'));assert.equal(prepares.length,2);assert.ok(prepares.every(item=>item.body.p_nonce===NONCE));
 assert.equal(app.requests.filter(item=>item.method==='DELETE'&&item.path==='/storage/v1/object/mayak-video').length,1);
 assert.equal(app.requests.filter(item=>item.method==='DELETE'&&item.path==='/storage/v1/object/mayak-video-source').length,2);privateDataAbsent(second,app);
});

test('storage edge: invalid prepared destinations are not fetched and private RPC failures are sanitized',async()=>{
 for(const target of [{bucket:'unexpected',path:'x'},{bucket:'mayak',path:'../x'},{bucket:'mayak',path:'/x'},{bucket:'mayak',path:''}]){
  const app=setup({prepare:()=>({id:OPERATION,items:[{id:uuid(10),status:'pending',...target}]}),finish:body=>({id:body.p_object,status:'failed'})});
  const response=await app.handle(app.request({action:'delete',items:app.selection().slice(0,1),nonce:NONCE}));assert.equal(response.status,200);
  assert.equal(app.requests.filter(item=>item.method==='DELETE').length,0);assert.equal((await response.json()).operation.items[0].status,'failed');
 }
 for(const [rpcFailure,rpcCode,rpcStatus,expected] of [['overview','42P01',500,502],['prepare','P0001',400,409],['overview','42501',403,403]]){
  const app=setup({rpcFailure,rpcCode,rpcStatus}),response=await app.handle(app.request({action:rpcFailure==='prepare'?'delete':'overview',items:app.selection(),nonce:NONCE}));
  assert.equal(response.status,expected);const raw=await response.text();assert.ok(!raw.includes(app.service));assert.ok(!raw.includes('SQL'));assert.ok(!raw.includes('relation'));assert.equal(app.requests.filter(item=>item.method==='DELETE').length,0);
 }
 const unconfigured=setup({env:{SUPABASE_SERVICE_ROLE_KEY:''}});assert.equal((await unconfigured.handle(unconfigured.request())).status,503);assert.equal(unconfigured.requests.length,0);
});

test('storage edge: mismatched prepared plans are rejected wholesale and recovery DTO never exposes private targets',async()=>{
 const target={id:uuid(10),status:'pending',bucket:'mayak',path:OTHER+'/private-plan.mp4'};
 for(const items of [[],[target,target],[{...target,id:uuid(99)}]]){
  const app=setup({prepare:()=>({id:OPERATION,items})});
  assert.equal((await app.handle(app.request({action:'delete',items:app.selection().slice(0,1),nonce:NONCE}))).status,502);
  assert.equal(app.requests.filter(item=>item.method==='DELETE'||item.path.endsWith('_finish')).length,0);
 }
 const privatePath=OTHER+'/recovery-private.mp4';
 const app=setup({overview:()=>({storage:{used_bytes:1500,objects_count:1,unknown_size_count:0},items:[],
  path:privatePath,signed_url:BASE+'/storage/private?token=secret',
  pending_operation:{id:OPERATION,nonce:NONCE,path:privatePath,items:[{id:uuid(10),version:'saved-version',bytes:1500,status:'pending',bucket:'mayak-video',path:privatePath,error:'private backend internals'}]}})});
 const response=await app.handle(app.request());assert.equal(response.status,200);const body=await response.json();
 assert.deepEqual(body.pending_operation,{id:OPERATION,nonce:NONCE,items:[{id:uuid(10),version:'saved-version',bytes:1500,status:'failed'}]});
 assert.ok(!JSON.stringify(body).includes(privatePath));assert.ok(!JSON.stringify(body).includes('backend internals'));assert.ok(!JSON.stringify(body).includes('token=secret'));
});

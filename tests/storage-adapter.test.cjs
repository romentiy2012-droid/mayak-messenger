const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('cloud.js','utf8');
const BASE='https://example.supabase.co',TOKEN='actual.session.jwt';
const legacyKey=role=>'header.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.signature';
function setup(options={}){
 const requests=[],clients=[];
 const config={supabaseURL:BASE,supabasePublishableKey:'sb_publishable_client_key',...options.config};
 const client={auth:{getSession:async()=>({data:{session:options.noSession?null:{access_token:TOKEN,user:{id:'verified-user'}}},error:options.authError||null})},
  rpc(){throw Error('storage operations must use the authenticated Edge endpoint');}};
 const window={MAYAK_CONFIG:config,MayakSupabase:{createClient(...args){clients.push(args);return client;}}};
 const fetch=async(input,init)=>{
  requests.push({url:String(input),...init});
  if(options.networkFailure)throw Error('network unavailable');
  return new Response(options.rawBody??JSON.stringify(options.response??{storage:{used_bytes:123},traffic:{status:'unavailable',used_bytes:null}}),{status:options.status||200,headers:{'Content-Type':'application/json'}});
 };
 vm.runInNewContext(code,{window,fetch,location:{pathname:'/mayak-messenger/',origin:'https://romentiy2012-droid.github.io'},localStorage:{getItem(){return null;},setItem(){},removeItem(){}},
  Response,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,atob:value=>Buffer.from(value,'base64').toString('binary')});
 return {api:window.MayakCloud.api,requests,clients,config};
}

test('storage adapter: real cloud route sends the session JWT and only the public API key to the correct Edge endpoint',async()=>{
 for(const key of ['sb_publishable_client_key',legacyKey('anon')]){
  const app=setup({config:{supabasePublishableKey:key}}),body={action:'delete',items:[{id:'object-id',version:'version'}],nonce:'stable_nonce_12345678'};
  const result=await app.api('storage',{method:'POST',body:JSON.stringify(body)});
  assert.equal(result.storage.used_bytes,123);assert.equal(result.traffic.used_bytes,null);assert.equal(app.requests.length,1);
  const sent=app.requests[0];assert.equal(sent.url,BASE+'/functions/v1/storage-admin');assert.equal(sent.method,'POST');
  assert.equal(sent.headers.apikey,key);assert.equal(sent.headers.Authorization,'Bearer '+TOKEN);assert.equal(sent.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(sent.body),body);assert.ok(sent.signal instanceof AbortSignal);
  assert.equal(app.clients.length,1);assert.equal(app.clients[0][0],BASE);assert.equal(app.clients[0][1],key);
 }
});

test('storage adapter: denied and unavailable Edge responses retain HTTP status and useful error text',async()=>{
 for(const status of [403,409,502]){
  const message=status===403?'Доступ только для администратора.':'Обновите список файлов.',app=setup({status,response:{error:message}});
  await assert.rejects(app.api('storage',{method:'POST',body:'{"action":"overview"}'}),error=>error.status===status&&error.message===message);assert.equal(app.requests.length,1);
 }
 const invalid=setup({status:502,rawBody:'<proxy failure>'});await assert.rejects(invalid.api('storage'),error=>error.status===502&&!error.message.includes('<proxy'));
 const offline=setup({networkFailure:true});await assert.rejects(offline.api('storage'),/network unavailable/);
});

test('storage adapter: no local session or invalid client credentials cannot send a request or ship a secret',async()=>{
 const guest=setup({noSession:true});await assert.rejects(guest.api('storage'),error=>error.status===401);assert.equal(guest.requests.length,0);
 const denied=setup({authError:{message:'session revoked',status:403}});await assert.rejects(denied.api('storage'),error=>error.status===403);assert.equal(denied.requests.length,0);
 for(const config of [{supabasePublishableKey:'sb_secret_never_in_browser'},{supabasePublishableKey:legacyKey('service_role')},{supabasePublishableKey:''},{supabaseURL:'https://evil.example'},{supabaseURL:BASE+'/unexpected'},{supabaseURL:'https://user:password@example.supabase.co'}]){
  const app=setup({config});await assert.rejects(app.api('storage'),error=>error.status===503);assert.equal(app.requests.length,0);assert.equal(app.clients.length,0);
 }
});

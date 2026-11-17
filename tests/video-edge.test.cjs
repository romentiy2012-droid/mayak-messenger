const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {transformSync}=require('esbuild');
const code=transformSync(fs.readFileSync('supabase/functions/video/index.ts','utf8'),{loader:'ts',format:'cjs',target:'node22'}).code;
function setup({lostCommit=false,cancelled=false,member=true}={}){
 const waited=[],requests=[],base='https://example.supabase.co',id='00000000-0000-4000-8000-000000000001',ticket='00000000-0000-4000-8000-000000000002';
 const job={id,ticket,state:'processing',output:id+'/'+id+'_'+ticket+'.mp4',source:id+'/'+'a'.repeat(24)+'.webm'};let committed=false;
 const fetch=async(url,options={})=>{
  requests.push({url,method:options.method,body:options.body});
  const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  if(url.endsWith('/auth/v1/user'))return json({id});
  if(url.endsWith('video_settings'))return json({url:'https://test.vercel.app/api/process',key:'x'.repeat(32)});
  if(url.endsWith('video_begin'))return member?json({...job,state:'queued'}):new Response('{"message":"Нет доступа к чату."}',{status:403});
  if(url.endsWith('video_claim'))return json(job);
  if(url.includes('/object/sign/'))return json({signedURL:'/object/sign/mayak-video-source/'+job.source+'?token=read'});
  if(url.includes('/object/upload/sign/'))return json({url:'/object/upload/sign/mayak-video/'+job.output+'?token=write'});
  if(url==='https://test.vercel.app/api/process')return json({id,ticket,output:job.output,meta:{video:'h264',audio:'aac',w:480,h:480,duration:1,size:1000}});
  if(url.endsWith('video_finish')){const body=JSON.parse(options.body);if(lostCommit&&!committed&&!body.p_error){committed=true;throw Error('response lost after commit');}return json({...job,state:cancelled?'cancelled':body.p_error&&!committed?'failed':'sent'});}
  if(options.method==='DELETE')return json([]);
  throw Error('Unexpected fetch '+url);
 };
 const context={exports:{},module:{exports:{}},Deno:{env:{get:name=>name==='SUPABASE_URL'?base:'test-key'},serve(){}},EdgeRuntime:{waitUntil:p=>waited.push(p)},fetch,Request,Response,URL,AbortSignal,console:{error(){}},setTimeout,clearTimeout};context.module.exports=context.exports;
 vm.runInNewContext(code,context);
 const request=(token='user')=>new Request(base+'/functions/v1/video',{method:'POST',headers:{Origin:'https://romentiy2012-droid.github.io',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({file:job.source,nonce:'nonce'})});
 return {...context.module.exports,request,waited,requests,job};
}
test('video edge: authenticated member, private signed job, background conversion and completion',async()=>{
 const app=setup(),result=await app.handle(app.request());assert.equal(result.status,200);
 assert.ok(!(await result.text()).includes('xxx'));await Promise.all(app.waited);
 const payload=JSON.parse(app.requests.find(r=>r.url.includes('test.vercel.app')).body);
 assert.match(payload.source,/\/storage\/v1\/object\/sign\/mayak-video-source\//);
 assert.match(payload.target,/\/storage\/v1\/object\/upload\/sign\/mayak-video\//);
 assert.ok(app.requests.some(r=>r.url.endsWith('/object/mayak-video-source')&&r.method==='DELETE'));
});
test('video edge: lost successful commit response preserves the published file',async()=>{
 const app=setup({lostCommit:true});await app.handle(app.request());await Promise.all(app.waited);
 assert.equal(app.requests.filter(r=>r.method==='DELETE'&&r.url.endsWith('/object/mayak-video')).length,0);
});
test('video edge: cancelled conversion discards output, outsider never reaches worker',async()=>{
 const app=setup({cancelled:true});await app.handle(app.request());await Promise.all(app.waited);
 assert.ok(app.requests.some(r=>r.method==='DELETE'&&r.url.endsWith('/object/mayak-video')));
 const outsider=setup({member:false});assert.equal((await outsider.handle(outsider.request())).status,403);assert.equal(outsider.waited.length,0);
 assert.equal((await outsider.handle(outsider.request(''))).status,401);
 const foreign=new Request('https://example.supabase.co/functions/v1/video',{method:'OPTIONS',headers:{Origin:'https://evil.example'}});
 assert.equal((await outsider.handle(foreign)).status,403);
});

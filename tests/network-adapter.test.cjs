const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const UID='00000000-0000-4000-8000-000000000001';
function adapter(fetch,upload=async()=>({data:{},error:null})){
 const client={auth:{getSession:async()=>({data:{session:{user:{id:UID},access_token:'synthetic-token'}},error:null})},storage:{from(){return {upload,info:async()=>({data:{size:7*1024*1024},error:null})};}}};
 const window={MAYAK_CONFIG:{supabaseURL:'https://fixture.supabase.co',supabasePublishableKey:'sb_publishable_fixture'},MayakSupabase:{createClient:()=>client}};
 vm.runInNewContext(fs.readFileSync('cloud.js','utf8'),{window,location:{pathname:'/',origin:'https://example.invalid'},localStorage:{getItem(){return JSON.stringify({user:{id:UID}})},setItem(){},removeItem(){}},crypto:crypto.webcrypto,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,Response,fetch,setTimeout,clearTimeout,atob,btoa});
 return window.MayakCloud;
}
test('TUS resumes at server offset after interruption, including lost final acknowledgement',async()=>{
 const chunk=6*1024*1024,item={user:UID,kind:'video',extension:'mp4',blob:new Blob([new Uint8Array(chunk+64)],{type:'video/mp4'})};
 let offset=0,fail=true,created=0;const patches=[],saved=[];
 const api=adapter(async(url,init)=>{
  assert.equal(init.headers.Authorization,'Bearer synthetic-token');assert.equal(init.headers['Tus-Resumable'],'1.0.0');
  if(init.method==='POST'){created++;return new Response(null,{status:201,headers:{Location:'https://fixture.supabase.co/storage/v1/upload/resumable/synthetic'}});}
  if(init.method==='HEAD')return new Response(null,{status:200,headers:{'Upload-Offset':String(offset)}});
  assert.equal(init.method,'PATCH');assert.equal(Number(init.headers['Upload-Offset']),offset);patches.push({offset,size:init.body.size});
  if(offset===chunk&&fail){fail=false;throw new TypeError('network interrupted');}
  offset+=init.body.size;return new Response(null,{status:204,headers:{'Upload-Offset':String(offset)}});
 });
 await assert.rejects(api.uploadQueued(item,async()=>saved.push({path:item.uploadPath,url:item.uploadURL}),()=>{}),/network interrupted/);
 const result=await api.uploadQueued(item,async()=>{},()=>{});assert.equal(created,1);assert.equal(result,item.uploadPath);assert.equal(offset,item.blob.size);
 assert.deepEqual(patches.map(x=>x.offset),[0,chunk,chunk]);assert.ok(saved.some(x=>x.url));
 // Simulate a crash after the completed upload but before path was saved as finished.
 assert.equal(await api.uploadQueued(item,async()=>{},()=>{}),item.uploadPath);assert.equal(patches.length,3);
});
test('small file retries reuse durable object path and never overwrite an existing file',async()=>{
 const calls=[],item={user:UID,kind:'photo',sticker:true,extension:'png',blob:new Blob(['synthetic'],{type:'image/png'})};
 const api=adapter(()=>{throw Error('No TUS for a small file');},async(path,blob,options)=>{calls.push({path,options});return calls.length===1?{error:{message:'lost response'}}:{error:{statusCode:409}};});
 await assert.rejects(api.uploadQueued(item,async()=>{},()=>{}));const stored=item.uploadPath;
 assert.equal(await api.uploadQueued(item,async()=>{},()=>{}),stored);assert.equal(calls[0].path,calls[1].path);assert.equal(calls[1].options.upsert,false);assert.match(stored,/\/sticker-[a-f0-9]{24}\.png$/);
});
test('resumable uploads reject another account and untrusted continuation URLs',async()=>{
 let requests=0;const api=adapter(async()=>{requests++;throw Error('must not request');});
 const item={user:UID,kind:'video',extension:'mp4',blob:new Blob([new Uint8Array(1024*1024)]),uploadPath:UID+'/synthetic.mp4',uploadURL:'https://untrusted.invalid/upload'};
 await assert.rejects(api.uploadQueued(item,async()=>{},()=>{}),/адрес/);assert.equal(requests,0);
 await assert.rejects(api.uploadQueued({...item,user:'someone-else'},async()=>{},()=>{}),/Вход изменился/);assert.equal(requests,0);
});

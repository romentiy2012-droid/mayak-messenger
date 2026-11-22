const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
test('cloud uploads stickers to the existing private bucket with distinct safe PNG paths',async()=>{
 const calls=[],user='00000000-0000-4000-8000-000000000001';
 const client={auth:{getSession:async()=>({data:{session:{user:{id:user}}},error:null})},storage:{from(bucket){return {upload:async(path,blob,options)=>{calls.push({bucket,path,blob,options});return {data:{path},error:null};}};}}};
 const window={MAYAK_CONFIG:{supabaseURL:'https://fixture.supabase.co',supabasePublishableKey:'sb_publishable_fixture'},MayakSupabase:{createClient:()=>client}};
 vm.runInNewContext(fs.readFileSync('cloud.js','utf8'),{window,location:{pathname:'/',origin:'https://example.invalid'},localStorage:{getItem(){return null},setItem(){},removeItem(){}},crypto:crypto.webcrypto,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,atob:s=>Buffer.from(s,'base64').toString('binary')});
 const blob=new Blob(['synthetic'],{type:'image/png'}),a=await window.MayakCloud.upload(blob,'png',undefined,'sticker-'),b=await window.MayakCloud.upload(blob,'png',undefined,'sticker-');
 assert.match(a,new RegExp('^'+user+'/sticker-[a-f0-9]{24}\\.png$'));assert.notEqual(a,b);assert.equal(calls[0].bucket,'mayak');assert.equal(calls[0].options.contentType,'image/png');
 await assert.rejects(window.MayakCloud.upload(blob,'png',undefined,'../'));assert.equal(calls.length,2);
});

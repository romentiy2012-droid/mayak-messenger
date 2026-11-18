const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('poll adapter: all operations use authenticated RPC without actor spoofing',async()=>{
 const calls=[],context={window:{MAYAK_CONFIG:{supabaseURL:'https://unit.supabase.co',supabasePublishableKey:'sb_publishable_test'},MayakSupabase:{createClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:{message:{id:1}},error:null};}})}},location:{pathname:'/',origin:'https://app.example'},URL,URLSearchParams,TextEncoder,TextDecoder,crypto:require('node:crypto').webcrypto,localStorage:{getItem(){return null},removeItem(){},setItem(){}},AbortController,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync('cloud.js','utf8'),context);const api=context.window.MayakCloud.api;
 const send=(route,body)=>api(route,{method:'POST',body:JSON.stringify(body)});
 await send('poll-create',{question:'Вопрос',options:['А','Б'],multiple:true,anonymous:false,nonce:'create',peer:'peer',reply:7,user:'forged'});
 await send('poll-get',{id:1,voters:true});await send('poll-vote',{id:1,choices:[],nonce:'clear',user:'forged'});await send('poll-close',{id:1});
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[
  {name:'mayak_poll_create',args:{p_question:'Вопрос',p_options:['А','Б'],p_multiple:true,p_anonymous:false,p_nonce:'create',p_peer:'peer',p_reply:7}},
  {name:'mayak_poll_get',args:{p_id:1,p_voters:true}},{name:'mayak_poll_vote',args:{p_id:1,p_choices:[],p_nonce:'clear'}},{name:'mayak_poll_close',args:{p_id:1}}
 ]);
});

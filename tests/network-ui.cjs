// Local diagnosis of weak-network fixes. All users, messages and cloud replies are synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const root=path.resolve(__dirname,'..'),HOST='network-fixture.supabase.co',UID='00000000-0000-4000-8000-000000000001';
const user={id:UID,aud:'authenticated',role:'authenticated',email:'synthetic@example.invalid',app_metadata:{provider:'email'},user_metadata:{},created_at:'2026-01-01T00:00:00Z'};
const member={id:UID,name:'Синтетический участник',owner:false,last_read:0,last_seen:new Date().toISOString()};
const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),exp=Math.floor(Date.now()/1000)+3600;
const saved={access_token:b({alg:'HS256',typ:'JWT'})+'.'+b({sub:UID,aud:'authenticated',role:'authenticated',exp})+'.synthetic',refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:3600,expires_at:exp,user};
const textMessage={id:100,rev:100,user_id:UID,name:member.name,text:'Тестовая история',nonce:'synthetic',created:new Date().toISOString(),kind:'text',peer_a:null,peer_b:null};
const mediaMessages=Array.from({length:30},(_,i)=>({...textMessage,id:i+1,rev:i+1,text:'',kind:i<20?'photo':'voice',file:UID+'/synthetic-'+i+(i<20?'.jpg':'.m4a'),file_meta:i<20?{w:400,h:400,mime:'image/jpeg'}:{duration:10,mime:'audio/mp4'}}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const result={version:require('../package.json').version,started:new Date().toISOString(),cases:[],realCloudRequests:0};
let browser,server,origin,navigationDelay=0;
const contexts=[];
async function fixture(opts={}){
 const probe={delay:opts.delay||0,rows:opts.media?mediaMessages:[textMessage],heartbeatFail:!!opts.heartbeatFail,sendFail:false,mediaFail:true,loseResponse:false,posts:[],profileHold:false,requests:[],release:[],blocked:[],errors:[]};
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:opts.sw?'allow':'block'});contexts.push(context);
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin===origin)return route.continue();
  if(url.hostname!==HOST){probe.blocked.push(url.origin);return route.abort();}
  const entry={path:url.pathname,method:req.method(),at:Date.now()};probe.requests.push(entry);
  const json=async(body,status=200)=>{entry.done=Date.now();await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});};
  if(probe.delay)await sleep(probe.delay);
  if(url.pathname==='/rest/v1/mayak_members'){
   if(url.searchParams.has('id')&&probe.profileHold)await new Promise(r=>probe.release.push(r));
   return json([member]);
  }
  if(url.pathname==='/rest/v1/rpc/mayak_profile')return probe.heartbeatFail?route.abort('internetdisconnected'):json(member);
  if(url.pathname==='/rest/v1/mayak_messages')return json(url.searchParams.get('peer_a')==='is.null'||url.searchParams.has('rev')?probe.rows:[]);
  if(url.pathname==='/rest/v1/rpc/mayak_post_to'){const body=JSON.parse(req.postData());probe.posts.push({text:body.p_text,nonce:body.p_nonce});if(probe.sendFail)return route.abort('internetdisconnected');if(probe.loseResponse){probe.loseResponse=false;return route.abort('internetdisconnected');}return json({...textMessage,id:500,rev:500,text:body.p_text});}
  if(url.pathname==='/rest/v1/rpc/mayak_attach_to'){const body=JSON.parse(req.postData());return json({...textMessage,id:501,rev:501,kind:body.p_kind,file:body.p_file,file_meta:body.p_meta});}
  if(url.pathname.startsWith('/storage/v1/'))return probe.mediaFail?route.abort('internetdisconnected'):req.method()==='POST'?json({Key:'synthetic'}):route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7gkAAAAASUVORK5CYII=','base64')});
  if(url.pathname.startsWith('/rest/v1/'))return json([]);
  if(url.pathname==='/auth/v1/health')return json({ok:true});
  if(url.pathname==='/auth/v1/token')return json(saved);
  probe.blocked.push(url.pathname);return route.abort();
 });
 await context.addInitScript(({saved,key})=>{localStorage.setItem(key,JSON.stringify(saved));localStorage.setItem('mayak.push.off','1');localStorage.setItem('mayak.skin','classic');},{saved,key:'mayak.cloud.auth:'+HOST});
 const page=await context.newPage();page.on('pageerror',e=>probe.errors.push(e.message));
 const start=Date.now();await page.goto(origin+'/',{waitUntil:'domcontentloaded'});
 return {page,context,probe,start,async close(){probe.profileHold=false;probe.release.splice(0).forEach(r=>r());await context.close();}};
}
async function main(){
 const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
 server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,decodeURIComponent(pathname).slice(1)||'index.html');
  if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404).end();return;}
  if(pathname==='/'&&navigationDelay)await sleep(navigationDelay);
  let data=fs.readFileSync(file);
  if(file===path.join(root,'config.js'))data=Buffer.from(`window.MAYAK_CONFIG={supabaseURL:'https://${HOST}',supabasePublishableKey:'sb_publishable_synthetic'};`);
  if(file===path.join(root,'cloud.js'))data=Buffer.concat([data,Buffer.from('\nwindow.MayakCloud.watch=()=>{};')]);
  res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'}).end(data);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
 {
  const f=await fixture({delay:800,media:true}),{page,probe}=f;
  try{
   await expect(page.locator('.message-row')).toHaveCount(30,{timeout:15000});const elapsed=Date.now()-f.start;
   assert.ok(elapsed<4000,'history should no longer wait for five sequential requests');
   await page.waitForTimeout(1500);const media=probe.requests.filter(r=>r.path.startsWith('/storage/')).length;
   assert.ok(media>0&&media<20,'only nearby media should load, not the entire history: '+media);
   probe.delay=0;probe.mediaFail=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
   await expect.poll(()=>probe.requests.filter(r=>r.path.startsWith('/storage/')).length).toBeGreaterThan(media);
   result.cases.push({name:'independent-history-lazy-media-and-reconnect',historyVisibleMs:elapsed,nearbyMediaAttempts:media,allMedia:30});
   assert.deepEqual(probe.blocked,[]);assert.deepEqual(probe.errors,[]);
  }finally{await f.close();}
 }
 {
  const f=await fixture(),{page,probe}=f;
  try{
   await expect(page.locator('[data-id="100"]')).toBeVisible();
   await expect.poll(()=>page.evaluate(async()=>!!(await (await import('/js/offline.js')).loadHistory('00000000-0000-4000-8000-000000000001'))?.messages?.length)).toBe(true);
   probe.sendFail=true;await page.locator('#message-input').fill('Сохранить отправку');await page.locator('#send-button').tap();
   await expect(page.locator('#message-input')).toHaveValue('');await expect(page.locator('.outbox-row')).toHaveCount(1);
   await expect.poll(()=>probe.requests.filter(r=>r.path.endsWith('mayak_post_to')).length).toBe(1);
   await expect.poll(()=>page.evaluate(async()=>(await import('/js/core.js')).state.online)).toBe(false);
   probe.profileHold=true;const start=Date.now();await page.reload({waitUntil:'domcontentloaded'});
   await expect(page.locator('[data-id="100"]')).toBeVisible();await expect(page.locator('.outbox-row')).toHaveCount(1);
   const reopened=Date.now()-start;assert.ok(reopened<2000);
   assert.equal(await page.evaluate(async()=>(await import('/js/core.js')).state.verified),false);
   probe.sendFail=false;probe.profileHold=false;probe.release.splice(0).forEach(r=>r());
   await expect(page.locator('[data-id="500"]')).toBeVisible({timeout:10000});await expect(page.locator('.outbox-row')).toHaveCount(0);
   result.cases.push({name:'queue-persists-through-restart-and-sends-after-verification',reopenedMs:reopened,autoRetrySucceeded:true});
   // Server received a message but the response was lost. Retried nonce is unchanged.
   probe.loseResponse=true;await page.locator('#message-input').fill('Ответ потерян');await page.locator('#send-button').tap();
   await expect(page.locator('.outbox-row')).toHaveCount(1);await page.evaluate(()=>window.dispatchEvent(new Event('online')));
   await expect(page.locator('.outbox-row')).toHaveCount(0,{timeout:10000});
   const attempts=probe.posts.filter(x=>x.text==='Ответ потерян');assert.ok(attempts.length>=2);assert.equal(new Set(attempts.map(x=>x.nonce)).size,1);
   result.cases.push({name:'lost-response-retries-same-nonce',attempts:attempts.length,nonces:1});
   probe.sendFail=true;await page.locator('#message-input').fill('Локально');await page.locator('#send-button').tap();await expect(page.locator('.outbox-row')).toHaveCount(1);
   await page.evaluate(async()=>(await import('/js/session.js')).showJoin(true));
   await expect.poll(()=>page.evaluate(async()=>(await (await import('/js/offline.js')).queuedMessages('00000000-0000-4000-8000-000000000001')).length)).toBe(0);
   assert.equal(await page.evaluate(async()=>(await import('/js/offline.js')).loadHistory('00000000-0000-4000-8000-000000000001')),null);
   result.cases.push({name:'logout-clears-account-history-and-unsent-messages',cleared:true});
   assert.deepEqual(probe.blocked,[]);assert.deepEqual(probe.errors,[]);
  }finally{await f.close();}
 }
 {
  const f=await fixture({heartbeatFail:true}),{page,probe}=f;
  try{await expect(page.locator('[data-id="100"]')).toBeVisible();assert.ok(probe.requests.some(r=>r.path==='/rest/v1/mayak_messages'));result.cases.push({name:'heartbeat-failure-does-not-block-messages',passed:true});assert.deepEqual(probe.errors,[]);}finally{await f.close();}
 }
 {
  const f=await fixture({sw:true}),{page,probe}=f;
  try{
   await expect(page.locator('[data-id="100"]')).toBeVisible();await page.waitForFunction(()=>!!navigator.serviceWorker.controller,{},{timeout:15000});
   const cached=await page.evaluate(async()=>!!await caches.match(location.href));assert.equal(cached,true);
   navigationDelay=4000;const start=Date.now();await page.reload({waitUntil:'domcontentloaded'});const elapsed=Date.now()-start;navigationDelay=0;assert.ok(elapsed<1800);
   result.cases.push({name:'cached-shell-immediate-with-slow-server',navigationMs:elapsed,serverDelayMs:4000});assert.deepEqual(probe.errors,[]);
  }finally{await f.close();}
 }
 {
  const f=await fixture(),{page,probe}=f;
  try{
   await expect(page.locator('[data-id="100"]')).toBeVisible();
   await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=c.height=32;c.getContext('2d').fillRect(8,8,16,16);await (await import('/js/composer.js')).attachSticker(await new Promise(r=>c.toBlob(r,'image/png')));});
   await page.locator('#send-button').tap();await expect(page.locator('.outbox-row')).toHaveCount(1);
   await expect.poll(()=>probe.requests.filter(r=>r.path.startsWith('/storage/')).length).toBeGreaterThan(0);
   await page.locator('#message-input').fill('Текст не ждёт файл');await page.locator('#send-button').tap();
   await expect(page.locator('[data-id="500"]')).toContainText('Текст не ждёт файл');
   await expect(page.locator('.outbox-row')).toHaveCount(1);
   const read=()=>page.evaluate(async()=>{const row=(await (await import('/js/offline.js')).queuedMessages('00000000-0000-4000-8000-000000000001'))[0];return {nonce:row.nonce,path:row.uploadPath,size:row.blob.size,type:row.blob.type,room:row.room};});
   const before=await read();assert.ok(before.size>0);assert.equal(before.type,'image/png');
   await page.reload();await expect(page.locator('.outbox-row')).toHaveCount(1);assert.deepEqual(await read(),before);
   probe.mediaFail=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
   await expect(page.locator('[data-id="501"] .message-sticker')).toBeVisible({timeout:10000});await expect(page.locator('.outbox-row')).toHaveCount(0);
   assert.deepEqual(probe.errors,[]);assert.deepEqual(probe.blocked,[]);
   result.cases.push({name:'media-survives-restart-with-original-path-and-does-not-block-text',blobPersisted:true,pathUnchanged:true});
  }finally{await f.close();}
 }
 result.finished=new Date().toISOString();result.status='passed';
}
main().catch(e=>{result.status='failed';result.failure=e.stack;process.exitCode=1;}).finally(async()=>{for(const c of contexts)await c.close().catch(()=>{});await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/network-ui.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));});

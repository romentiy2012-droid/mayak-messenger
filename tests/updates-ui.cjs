// Реальный жизненный цикл Service Worker и перезагрузки Chrome; только синтетическое облако.
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..');
const sourceVersion = require('../package.json').version;
const USER='00000000-0000-4000-8000-000000000001',PEER='00000000-0000-4000-8000-000000000002';
async function clientVersion(page){try{return await page.evaluate(async()=>(await import('/js/updates.js')).APP_VERSION);}catch(error){if(/Execution context was destroyed/.test(error.message))return 'navigating';throw error;}}
const mock=`(()=>{
 const uid='${USER}',peer='${PEER}',now=new Date().toISOString(),user={id:uid,name:'Тестовый владелец',owner:true,last_seen:now,last_read:0},people=[user,{id:peer,name:'Тестовый собеседник',last_seen:now,last_read:0}];
 window.loadId=crypto.randomUUID();window.updateTest={release:null};
 window.MayakCloud={async api(path,options={}){
  if(path==='session')return {user,room:'Тестовый круг'};
  if(path.startsWith('events'))return {people,messages:[],reads:[],direct_full:true};
  if(path==='hold')return new Promise(resolve=>window.updateTest.release=resolve);
  if(path==='messages'){const b=JSON.parse(options.body);return {message:{id:1,rev:1,user_id:uid,name:user.name,text:b.text,nonce:b.nonce,kind:'text',created:now,reactions:{},peer_a:null,peer_b:null}};}
  return {};
 },watch(){},stop(){}};
})();`;
async function fixture(clock=false,options={}){
 const release={worker:'2.14.0',client:'2.14.0',broken:false,swRequests:0,httpCache:!!options.httpCache,legacy:!!options.legacy};
 const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{
  const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html',file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404).end();return;}
  if(release.broken&&relative==='js/updates.js'){res.writeHead(503).end();return;}
  if(relative==='sw.js')release.swRequests++;
  let body=relative==='cloud.js'?Buffer.from(mock):fs.readFileSync(relative==='sw.js'&&release.legacy?path.join(root,'tests/fixtures/sw-2.22.2.js'):file);
  if(['.js','.html'].includes(path.extname(file)))body=Buffer.from(body.toString().replaceAll(relative==='sw.js'&&release.legacy?'2.22.2':sourceVersion,relative==='sw.js'?release.worker:release.client));
  res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':release.httpCache&&relative!=='sw.js'?'public, max-age=3600':'no-store'});res.end(body);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'allow'});
 await context.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));
 const consoleErrors=[];context.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(clock)await page.clock.install();
 await page.goto('http://127.0.0.1:'+server.address().port+(options.startPath||''));await expect(page.locator('#chat')).toBeVisible();
 try{await page.waitForFunction(()=>!!navigator.serviceWorker.controller);}catch(error){
  console.error('Initial worker diagnostics',JSON.stringify({consoleErrors,state:await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();return {active:r?.active?.state,installing:r?.installing?.state,caches:await caches.keys()};})}));
  await browser.close();await new Promise(r=>server.close(r));throw error;
 }
 const version=()=>clientVersion(page);
 const update=async(worker,client=worker)=>{Object.assign(release,{worker,client});await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update();});};
 const unchanged=async id=>{await page.waitForTimeout(4200);assert.equal(await page.evaluate(()=>window.loadId),id);};
 return {release,browser,context,page,errors,version,update,unchanged,close:async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));}};
}
test('automatic update bypasses previously cached HTTP shell without restart',{timeout:45000},async()=>{
 const f=await fixture(false,{httpCache:true});try{
  await f.unchanged(await f.page.evaluate(()=>window.loadId));
  await f.page.locator('#message-input').fill('Черновик при обновлении через HTTP-кэш');await f.page.locator('#message-input').blur();
  await f.update('2.14.1');await expect.poll(f.version,{timeout:20000}).toBe('2.14.1');
  await expect(f.page.locator('#message-input')).toHaveValue('Черновик при обновлении через HTTP-кэш');await expect(f.page.locator('#update-banner')).toBeHidden();assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('automatic update recovers an already stuck legacy client without closing the app',{timeout:60000},async()=>{
 const f=await fixture(true,{httpCache:true,legacy:true});try{const {page,release}=f;
  await f.unchanged(await page.evaluate(()=>window.loadId));await page.locator('#message-input').fill('Сохранить черновик застрявшего клиента');await page.locator('#message-input').blur();
  await f.update('2.14.1');await expect(page.locator('#update-banner')).toContainText('при следующем открытии',{timeout:20000});assert.equal(await f.version(),'2.14.0');assert.equal(await page.evaluate(()=>sessionStorage.getItem('mayak.update.reload')),'2.14.1');
  await page.screenshot({path:path.join(root,'test-results/update-legacy-stuck-before.png')});
  Object.assign(release,{legacy:false,worker:'2.14.2',client:'2.14.2'});await page.clock.fastForward(61000);await expect.poll(f.version,{timeout:20000}).toBe('2.14.2');await expect(page.locator('#update-banner')).toBeHidden();await expect(page.locator('#message-input')).toHaveValue('Сохранить черновик застрявшего клиента');assert.equal(await page.evaluate(async()=>(await import('/js/core.js')).state.user.id),USER);
  await page.screenshot({path:path.join(root,'test-results/update-legacy-recovered-after.png')});assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('automatic update serves the installed shell for index.html and launch parameters',{timeout:45000},async()=>{
 const f=await fixture(false,{httpCache:true,startPath:'/index.html?source=pwa'});try{
  await f.unchanged(await f.page.evaluate(()=>window.loadId));await f.update('2.14.1');await expect.poll(f.version,{timeout:20000}).toBe('2.14.1');await expect(f.page.locator('.composer-footnote')).toContainText('2.14.1');await expect(f.page.locator('#update-banner')).toBeHidden();assert.ok(f.page.url().includes('/index.html?source=pwa'));assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('automatic update waits while the inline expression panel is open',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;try{
  const initial=await page.evaluate(()=>window.loadId);await page.locator('#stickers-button').tap();await expect(page.locator('#expression-panel')).toBeVisible();
  await f.update('2.14.9');await expect(page.locator('#update-banner')).toBeVisible();await f.unchanged(initial);await page.locator('#stickers-button').tap();await expect.poll(f.version,{timeout:20000}).toBe('2.14.9');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('automatic update waits for the weather monitor and resumes after returning to chat',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;try{
  await page.locator('#message-input').fill('Черновик под метеостанцией');await page.locator('#weather-button').tap();await expect(page.locator('#meteo-screen')).toBeVisible();
  const initial=await page.evaluate(()=>window.loadId);await f.update('2.14.9');await f.unchanged(initial);await expect(page.locator('#meteo-screen')).toBeVisible();
  await page.locator('#meteo-back').tap();await expect.poll(f.version,{timeout:20000}).toBe('2.14.9');await expect(page.locator('#update-banner')).toBeHidden();await expect(page.locator('#message-input')).toHaveValue('Черновик под метеостанцией');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('automatic update waits for the photo viewer and resumes after closing it',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;try{
  await page.evaluate(async()=>{const {state}=await import('/js/core.js'),media=await import('/js/media.js'),blob=await (await fetch('/icon-512.png')).blob();media.rememberMedia('synthetic/update-photo.png',blob);state.messages.push({id:999,file:'synthetic/update-photo.png',kind:'photo'});media.openViewer(999);});
  await expect(page.locator('#viewer-layer')).toBeVisible();const initial=await page.evaluate(()=>window.loadId);await f.update('2.14.9');await expect(page.locator('#update-banner')).toBeVisible();await f.unchanged(initial);await expect(page.locator('#viewer-layer')).toBeVisible();
  await page.locator('#viewer-close').tap();await expect.poll(f.version,{timeout:20000}).toBe('2.14.9');await expect(page.locator('#update-banner')).toBeHidden();assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('automatic update: complete worker installation, safe deferral, drafts/chat, recording and offline recovery',{timeout:180000},async()=>{
 const f=await fixture(),{page,context,release,version,update,unchanged}=f;
 try{
  const initial=await page.evaluate(()=>window.loadId);await unchanged(initial); // first install must not reload
  await page.evaluate(async peer=>(await import('/js/messages.js')).openRoom(peer),PEER);
  await page.locator('#message-input').fill('Черновик остаётся в личном чате');
  await page.locator('#attach-button').tap();await page.getByRole('button',{name:'Опрос',exact:true}).tap();
  await page.getByRole('textbox',{name:'Вопрос опроса'}).fill('Сохранить вопрос');
  await update('2.14.1');await expect(page.locator('#update-banner')).toBeVisible();await unchanged(initial);
  await expect(page.getByRole('textbox',{name:'Вопрос опроса'})).toHaveValue('Сохранить вопрос');
  await page.locator('#dialog-close').tap();await expect.poll(version,{timeout:20000}).toBe('2.14.1');
  await expect(page.locator('#message-input')).toHaveValue('Черновик остаётся в личном чате');
  assert.equal(await page.evaluate(async()=>(await import('/js/core.js')).state.room),PEER);
  await page.locator('#attach-button').tap();await page.getByRole('button',{name:'Опрос',exact:true}).tap();await expect(page.getByRole('textbox',{name:'Вопрос опроса'})).toHaveValue('Сохранить вопрос');await page.locator('#dialog-close').tap();
  // A failed precache cannot activate an incomplete release or reload the working app.
  const second=await page.evaluate(()=>window.loadId);release.broken=true;await update('2.14.2');await unchanged(second);assert.equal(await version(),'2.14.1');
  release.broken=false;
  // Focus/IME, an unsent file, an edit and an in-flight mutation each block the same pending update.
  await page.locator('#message-input').focus();await update('2.14.2');await expect(page.locator('#update-banner')).toBeVisible();await unchanged(second);
  await page.evaluate(()=>document.dispatchEvent(new CompositionEvent('compositionstart')));await page.locator('#message-input').blur();await unchanged(second);
  await page.evaluate(async()=>{(await import('/js/core.js')).state.attachment={kind:'photo',blob:new Blob(['synthetic'])};document.dispatchEvent(new CompositionEvent('compositionend'));});await unchanged(second);
  await page.evaluate(async()=>{const {state}=await import('/js/core.js');state.attachment=null;state.editing=99;});await unchanged(second);
  await page.evaluate(async()=>{const {state,post}=await import('/js/core.js');state.editing=null;window.holding=post('hold',{});});await unchanged(second);
  // Permissions can be pending before the recording bar is visible.
  await page.locator('#message-input').fill('');await page.locator('#message-input').blur();
  await page.evaluate(()=>{const real=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=constraints=>new Promise(resolve=>window.updateTest.allowMic=()=>real(constraints).then(resolve));});
  await page.locator('#voice-button').tap();await page.evaluate(()=>window.updateTest.release({}));await unchanged(second);
  await page.evaluate(()=>window.updateTest.allowMic());await expect(page.locator('#record-bar')).toBeVisible();await unchanged(second);
  // Offline never triggers a forced reload; reconnect applies the fully installed release.
  await context.setOffline(true);await page.locator('#record-cancel').tap();await unchanged(second);
  await context.setOffline(false);await expect.poll(version,{timeout:20000}).toBe('2.14.2');
  const third=await page.evaluate(()=>window.loadId);await unchanged(third);assert.deepEqual(f.errors,[]);
  // An explicit check uses the real browser registration and reaches the server.
  const before=release.swRequests;await page.evaluate(async()=>{await (await import('/js/updates.js')).checkForUpdates(true);});assert.ok(release.swRequests>before);
 }finally{await f.close();}
});

test('automatic update: minute timer, another hidden tab and unavailable draft storage',{timeout:90000},async()=>{
 const f=await fixture(true),{page,context,release,version,unchanged}=f;
 try{
  const other=await context.newPage();other.on('pageerror',e=>f.errors.push(e.message));await other.goto(page.url());await expect(other.locator('#chat')).toBeVisible();await other.waitForFunction(()=>!!navigator.serviceWorker.controller);
  const hiddenId=await other.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));return window.loadId;});
  await page.bringToFront();assert.equal(await page.evaluate(()=>document.hidden),false);
  // Let the second tab finish its initial update before fast-forwarding a whole minute.
  await unchanged(await page.evaluate(()=>window.loadId));
  Object.assign(release,{worker:'2.14.1',client:'2.14.1'});
  // Advance the real page timer; do not call registration.update() in this scenario.
  await page.clock.fastForward(61000);await expect.poll(version,{timeout:20000}).toBe('2.14.1');
  await f.unchanged(await page.evaluate(()=>window.loadId));assert.equal(await other.evaluate(()=>window.loadId),hiddenId);
  await other.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await other.bringToFront();
  await expect.poll(()=>clientVersion(other),{timeout:20000}).toBe('2.14.1');
  await page.bringToFront();
  const current=await page.evaluate(()=>window.loadId);await page.locator('#message-input').fill('Не потерять при переполнении памяти');await page.locator('#message-input').blur();
  await page.evaluate(()=>{window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('mayak.draft:'))throw new DOMException('Full','QuotaExceededError');return window.originalSet.call(this,key,value);};});
  Object.assign(release,{worker:'2.14.2',client:'2.14.2'});await page.clock.fastForward(61000);await expect(page.locator('#update-banner')).toBeVisible();await unchanged(current);
  await page.evaluate(()=>Storage.prototype.setItem=window.originalSet);await expect.poll(version,{timeout:20000}).toBe('2.14.2');await expect(page.locator('#message-input')).toHaveValue('Не потерять при переполнении памяти');
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('automatic update rejects mixed releases and retries the same target when host recovers',{timeout:60000},async()=>{
 const f=await fixture(),{page,version,update,unchanged}=f;
 try{
  const first=await page.evaluate(()=>window.loadId);await update('2.14.1','2.14.0');
  await unchanged(first);assert.equal(await version(),'2.14.0');await expect(page.locator('#update-banner')).toBeHidden();
  assert.equal(await page.evaluate(async()=>{const c=new MessageChannel();return new Promise(resolve=>{c.port1.onmessage=e=>resolve(e.data.version);navigator.serviceWorker.controller.postMessage({type:'MAYAK_VERSION'},[c.port2]);});}),'2.14.0');
  await update('2.14.1');await expect.poll(version,{timeout:20000}).toBe('2.14.1');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('automatic update: loading voice and unavailable session storage postpone reload',{timeout:45000},async()=>{
 const f=await fixture(),{page,update,unchanged,version}=f;
 try{
  await page.evaluate(async peer=>{
   const {state}=await import('/js/core.js');state.messages.push({id:90,kind:'voice',file:'synthetic/loading.webm',user_id:peer,file_meta:{duration:3}});
   window.MayakCloud.download=()=>new Promise(resolve=>window.releaseVoice=resolve);
   window.pendingVoice=(await import('/js/media.js')).toggleVoice(90).catch(()=>{});
  },PEER);
  await page.waitForFunction(()=>!!window.releaseVoice);const initial=await page.evaluate(()=>window.loadId);
  await update('2.14.1');await expect(page.locator('#update-banner')).toBeVisible();await unchanged(initial);
  assert.equal(await page.evaluate(async()=>(await import('/js/media.js')).voicePlaying()),true);
  await page.screenshot({path:path.join(root,'test-results/auto-update-pending-mobile.png'),fullPage:true});
  await page.evaluate(async()=>{
   window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===sessionStorage)throw new DOMException('Blocked','SecurityError');return window.originalSet.call(this,key,value);};
   (await import('/js/media.js')).stopVoice();window.releaseVoice(new Blob(['synthetic'],{type:'audio/webm'}));
  });await unchanged(initial);
  await page.evaluate(()=>Storage.prototype.setItem=window.originalSet);await expect.poll(version,{timeout:20000}).toBe('2.14.1');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

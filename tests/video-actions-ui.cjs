// Изолированный сценарий полученного кружочка: настоящие Chrome touch events и MP4;
// облако заменено заглушкой, рабочие аккаунты и переписка не используются.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium,expect}=require('@playwright/test');
const root=path.resolve(__dirname,'..'),GUEST='00000000-0000-4000-8000-000000000002',PEER='00000000-0000-4000-8000-000000000003',VIDEO=31;
const mock=`(() => {
 const guest='${GUEST}',peer='${PEER}',now=new Date().toISOString();
 const user={id:guest,name:'Тестовый участник',owner:false,last_read:0,online:true,last_seen:now};
 const sender={id:peer,name:'Тестовый собеседник',owner:false,last_read:0,online:true,last_seen:now};
 const initial=Array.from({length:30},(_,i)=>({id:i+1,rev:i+1,user_id:peer,name:sender.name,text:'Синтетическая история '+(i+1),kind:'text',created:now,reactions:{},peer_a:guest,peer_b:peer}));
 initial.push({id:${VIDEO},rev:${VIDEO},user_id:peer,name:sender.name,text:'📹 Видеокружочек',kind:'video',file:'synthetic/video.mp4',file_meta:{duration:12},created:now,reactions:{},peer_a:guest,peer_b:peer});
 let messages=JSON.parse(localStorage.getItem('video.actions.messages')||'null')||initial;
 const clone=value=>JSON.parse(JSON.stringify(value)),save=()=>localStorage.setItem('video.actions.messages',JSON.stringify(messages));
 window.actionTest={downloads:0,plays:0,reactions:[],sends:[]};
 window.MayakCloud={
  async api(path,options={}){
   const route=path.split('?')[0],body=JSON.parse(options.body||'{}');
   if(route==='session')return {user:clone(user),room:'Тестовый круг'};
   if(route==='events')return {people:clone([user,sender]),messages:clone(messages),reads:[],direct_full:true};
   if(route==='react'){
    window.actionTest.reactions.push(clone(body));
    const index=messages.findIndex(m=>m.id===body.id),message=clone(messages[index]);
    message.rev=Math.max(...messages.map(m=>m.rev))+1;
    if(body.emoji)message.reactions[guest]=body.emoji;else delete message.reactions[guest];
    messages[index]=message;save();return {message:clone(message)};
   }
   if(route==='messages'){
    window.actionTest.sends.push(clone(body));
    const id=Math.max(...messages.map(m=>m.id))+1,message={id,rev:Math.max(...messages.map(m=>m.rev))+1,user_id:guest,name:user.name,text:body.text,nonce:body.nonce,kind:'text',created:new Date().toISOString(),reactions:{},reply_to:body.reply,peer_a:guest,peer_b:body.peer};
    messages.push(message);save();return {message:clone(message)};
   }
   return {};
  },watch(){},stop(){},
  async videoDownload(){window.actionTest.downloads++;return (await fetch('/__synthetic.mp4')).blob();}
 };
 document.addEventListener('play',event=>{if(event.target.closest?.('.video-note'))window.actionTest.plays++;},true);
})();`;

async function center(locator){
 await locator.scrollIntoViewIfNeeded();
 // Reply focuses the composer; let its layout settle before choosing native touch coordinates.
 let box=await locator.boundingBox();
 for(let attempt=0;attempt<8;attempt++){
  await locator.page().waitForTimeout(60);const next=await locator.boundingBox();
  if(box&&next&&Math.abs(box.x-next.x)<1&&Math.abs(box.y-next.y)<1&&Math.abs(box.height-next.height)<1){box=next;break;}box=next;
 }
 assert.ok(box,'touch target is on screen');
 return {x:box.x+box.width/2,y:box.y+box.height/2};
}
async function touchStart(cdp,p){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1,radiusX:2,radiusY:2,force:1}]});}
async function touchMove(cdp,p){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...p,id:1,radiusX:2,radiusY:2,force:1}]});}
async function touchEnd(cdp){await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
async function hold(page,cdp,locator){const p=await center(locator);await touchStart(cdp,p);await page.waitForTimeout(550);await expect(page.locator('#sheet-layer')).toBeVisible();await touchEnd(cdp);}
async function stats(page){return page.evaluate(()=>({downloads:window.actionTest.downloads,plays:window.actionTest.plays}));}
async function openPeer(page){await page.evaluate(async peer=>(await import('/js/messages.js')).openRoom(peer),PEER);}

test('received video: touch playback, reactions, reply, swipe, cancellation and accessible actions', {timeout:90000},async()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'mayak-video-actions-')),sample=path.join(temporary,'synthetic.mp4');
 execFileSync(require('../video-worker/node_modules/@ffmpeg-installer/ffmpeg').path,[
  '-y','-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x27816a:s=480x480:r=15',
  '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','12','-c:v','libx264','-preset','ultrafast','-profile:v','baseline','-pix_fmt','yuv420p','-c:a','aac','-ac','1','-b:a','32k','-movflags','+faststart',sample
 ],{windowsHide:true});
 const bytes=fs.readFileSync(sample),mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/__synthetic.mp4'){res.writeHead(200,{'Content-Type':'video/mp4'});res.end(bytes);return;}
  const relative=decodeURIComponent(url.pathname)==='/'?'index.html':decodeURIComponent(url.pathname).slice(1),file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/cloud.js',route=>route.fulfill({contentType:'text/javascript',body:mock}));
  await page.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));
  const base='http://127.0.0.1:'+server.address().port+'/';await page.goto(base);await expect(page.locator('#chat')).toBeVisible();await openPeer(page);
  const cdp=await context.newCDPSession(page),row=page.locator('[data-id="'+VIDEO+'"]'),video=row.locator('.video-note'),sheet=page.locator('#sheet-layer');
  await expect(video).toBeVisible();assert.equal(await row.evaluate(node=>node.classList.contains('own')),false);
  assert.equal(await page.evaluate(async()=>(await import('/js/core.js')).state.user.owner),false);
  assert.equal(await page.evaluate(()=>matchMedia('(hover:none)').matches),true);
  await expect(row.locator('.message-more')).toBeVisible();
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
  await page.screenshot({path:path.join(root,'test-results/video-actions-mobile.png')});

  // First hold has no cached/downloaded video: it must open actions without starting playback.
  await hold(page,cdp,video);await expect(sheet).toBeVisible();assert.deepEqual(await stats(page),{downloads:0,plays:0});
  // Some webviews emit a compatibility click despite cancelling touchend.
  await video.evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1})));
  await page.waitForTimeout(80);assert.deepEqual(await stats(page),{downloads:0,plays:0});
  await page.screenshot({path:path.join(root,'test-results/video-actions-mobile-sheet.png')});
  await expect(page.getByRole('button',{name:'Изменить',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Удалить',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Удалить (админ)',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Реакция ❤️',exact:true}).tap();await expect(sheet).toBeHidden();
  await expect(row.getByRole('button',{name:'Реакция ❤️, ваша',exact:true})).toBeVisible();
  assert.deepEqual(await page.evaluate(()=>window.actionTest.reactions),[{id:VIDEO,emoji:'❤️'}]);
  assert.deepEqual(await stats(page),{downloads:0,plays:0});
  // Reload reconstructs the row from the mock's saved RPC result, rather than trusting a local DOM chip.
  await page.reload();await expect(page.locator('#chat')).toBeVisible();await openPeer(page);
  await expect(row.getByRole('button',{name:'Реакция ❤️, ваша',exact:true})).toBeVisible();

  await hold(page,cdp,video);await page.getByRole('button',{name:'Ответить',exact:true}).tap();
  await expect(page.locator('#composer-context')).toBeVisible();await expect(page.locator('#context-text')).toContainText('Видеокружочек');
  await page.locator('#message-input').fill('Ответ на полученный кружочек');await page.locator('#send-button').tap();
  await expect(page.locator('#composer-context')).toBeHidden();
  const sent=await page.evaluate(()=>window.actionTest.sends);assert.equal(sent.length,1);assert.equal(sent[0].reply,VIDEO);assert.equal(sent[0].peer,PEER);assert.equal(sent[0].text,'Ответ на полученный кружочек');
  await expect(page.locator('.message-row.own [data-jump="'+VIDEO+'"]')).toBeVisible();assert.deepEqual(await stats(page),{downloads:0,plays:0});

  // A short native touch remains the normal play/pause control after menu gestures.
  await video.tap();await expect(video).toHaveClass(/playing/);await page.waitForFunction(()=>document.querySelector('.video-note video').currentTime>0);
  assert.deepEqual(await stats(page),{downloads:1,plays:1});
  await video.tap();await expect(video).not.toHaveClass(/playing/);
  const idle=await stats(page);
  const swipe=await center(video);await touchStart(cdp,swipe);await touchMove(cdp,{x:swipe.x-30,y:swipe.y});await touchMove(cdp,{x:swipe.x-80,y:swipe.y});await touchEnd(cdp);
  await expect(page.locator('#composer-context')).toBeVisible();await expect(sheet).toBeHidden();assert.deepEqual(await stats(page),idle);
  // A separate CDP probe loses the next compatibility click equally after text/video swipes.
  // Reset this unrelated composer control with a trusted mouse click; gestures stay real touch.
  await page.locator('#context-cancel').click();await expect(page.locator('#composer-context')).toBeHidden();

  // Short horizontal drag does not accidentally reply or play; cancelling a larger drag resets it.
  const short=await center(video);await touchStart(cdp,short);await touchMove(cdp,{x:short.x-24,y:short.y});await touchEnd(cdp);await page.waitForTimeout(550);
  await expect(sheet).toBeHidden();await expect(page.locator('#composer-context')).toBeHidden();assert.deepEqual(await stats(page),idle);
  const cancel=await center(video);await touchStart(cdp,cancel);await touchMove(cdp,{x:cancel.x-75,y:cancel.y});await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await page.waitForTimeout(550);
  await expect(sheet).toBeHidden();await expect(page.locator('#composer-context')).toBeHidden();assert.deepEqual(await stats(page),idle);
  assert.equal(await row.locator('.message-bubble').evaluate(node=>node.style.transform),'');
  const multi=await center(video);await touchStart(cdp,multi);await touchMove(cdp,{x:multi.x-30,y:multi.y});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:multi.x-30,y:multi.y,id:1,radiusX:2,radiusY:2,force:1},{x:multi.x+20,y:multi.y+15,id:2,radiusX:2,radiusY:2,force:1}]});
  await touchEnd(cdp);await page.waitForTimeout(550);
  await expect(sheet).toBeHidden();await expect(page.locator('#composer-context')).toBeHidden();assert.deepEqual(await stats(page),idle);
  assert.equal(await row.locator('.message-bubble').evaluate(node=>node.style.transform),'');

  // A vertical drag scrolls the actual history without opening actions or triggering playback.
  const before=await page.locator('#messages-scroll').evaluate(node=>node.scrollTop),vertical=await center(video);
  await touchStart(cdp,vertical);
  for(const dy of [15,35,65,100]){await touchMove(cdp,{x:vertical.x,y:vertical.y+dy});await page.waitForTimeout(35);}
  await touchEnd(cdp);await page.waitForTimeout(550);await expect(sheet).toBeHidden();await expect(page.locator('#composer-context')).toBeHidden();
  assert.ok(await page.locator('#messages-scroll').evaluate(node=>node.scrollTop)<before,'vertical touch scrolls the message history');assert.deepEqual(await stats(page),idle);
  await row.locator('.message-more').tap();await expect(sheet).toBeVisible();await page.getByRole('button',{name:'Отмена',exact:true}).tap();await expect(sheet).toBeHidden();
  await video.tap();await expect(video).toHaveClass(/playing/);await video.tap();await expect(video).not.toHaveClass(/playing/);

  // Desktop uses the same received message with mouse contextmenu and a keyboard-accessible ⋯.
  const desktop=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'}),desktopPage=await desktop.newPage();
  desktopPage.on('pageerror',error=>errors.push(error.message));await desktopPage.route('**/cloud.js',route=>route.fulfill({contentType:'text/javascript',body:mock}));
  await desktopPage.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));await desktopPage.goto(base);await expect(desktopPage.locator('#chat')).toBeVisible();await openPeer(desktopPage);
  const desktopRow=desktopPage.locator('[data-id="'+VIDEO+'"]');await desktopRow.locator('.video-note').click({button:'right'});await expect(desktopPage.locator('#sheet-layer')).toBeVisible();assert.deepEqual(await stats(desktopPage),{downloads:0,plays:0});
  await desktopPage.screenshot({path:path.join(root,'test-results/video-actions-desktop-sheet.png')});
  await desktopPage.keyboard.press('Escape');await expect(desktopPage.locator('#sheet-layer')).toBeHidden();
  await desktopRow.locator('.message-more').focus();await desktopPage.keyboard.press('Enter');await expect(desktopPage.locator('#sheet-layer')).toBeVisible();
  await desktopPage.getByRole('button',{name:'Ответить',exact:true}).click();await expect(desktopPage.locator('#composer-context')).toBeVisible();assert.deepEqual(await stats(desktopPage),{downloads:0,plays:0});
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
});

// Плавающее меню по видеореференсу. Только синтетическая переписка и локальные файлы.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..');
const mock=`(()=>{
 const now=new Date().toISOString(),user={id:'00000000-0000-4000-8000-000000000001',name:'Капитан теста',owner:false,last_seen:now},peer={id:'00000000-0000-4000-8000-000000000002',name:'Собеседник',last_seen:now};
 const base={created:now,reactions:{},kind:'text'};
 const messages=[{...base,id:1,rev:1,user_id:peer.id,name:peer.name,text:'Привет! Как дела? Есть новости по нашей встрече?'},{...base,id:2,rev:2,user_id:user.id,name:user.name,text:'Длинное сообщение. '.repeat(100)},{...base,id:3,rev:3,user_id:peer.id,name:peer.name,text:'🎤 Голосовое сообщение',kind:'voice',file:'synthetic/tone.wav',file_meta:{duration:2}}];
 window.menuTest={reactions:[],deleted:[],downloads:0,plays:0};
 const NativeAudio=window.Audio;window.Audio=function(...args){const audio=new NativeAudio(...args);audio.addEventListener('play',()=>window.menuTest.plays++);return audio;};window.Audio.prototype=NativeAudio.prototype;
 window.MayakCloud={async api(route,options={}){
  if(route==='session')return {user,room:'Тестовый круг'};
  if(route.startsWith('events'))return {people:[user,peer],messages,reads:[],direct_full:true};
  const body=JSON.parse(options.body||'{}'),m=messages.find(m=>m.id===body.id);
  if(route==='react'){window.menuTest.reactions.push(body);m.rev+=10;if(body.emoji)m.reactions[user.id]=body.emoji;else delete m.reactions[user.id];return {message:m};}
  if(route==='delete'){window.menuTest.deleted.push(body.id);Object.assign(m,{deleted:true,text:'',rev:m.rev+10});return {message:m};}
  return {};
 },watch(){},stop(){},async download(){window.menuTest.downloads++;return (await fetch('/synthetic.wav')).blob();}};
})();`;
function wav(){const rate=8000,b=Buffer.alloc(44+rate*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let i=0;i<rate*2;i++)b.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/rate)*6000),44+i*2);return b;}
async function fits(page){
 const geometry=await page.evaluate(()=>{
  const v=window.visualViewport,rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  return {viewport:{left:v?.offsetLeft||0,top:v?.offsetTop||0,width:v?.width||innerWidth,height:v?.height||innerHeight},parts:[...document.querySelectorAll('#sheet .sheet-panel,#sheet .sheet-selected')].map(rect)};
 });
 for(const r of geometry.parts){const v=geometry.viewport;assert.ok(r.width>0&&r.height>0,JSON.stringify(geometry));assert.ok(r.left>=v.left+10&&r.right<=v.left+v.width-10,JSON.stringify(geometry));assert.ok(r.top>=v.top+10&&r.bottom<=v.top+v.height-10,JSON.stringify(geometry));}
 for(let i=1;i<geometry.parts.length;i++)assert.ok(geometry.parts[i].top>=geometry.parts[i-1].bottom+6,JSON.stringify(geometry));
}

test('anchored menu: expanded reactions, small viewports, themes, keyboard focus and stale target', {timeout:60000},async()=>{
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'},tone=wav();
 const server=http.createServer((req,res)=>{const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html',file=path.resolve(root,relative);
  if(relative==='synthetic.wav'){res.writeHead(200,{'Content-Type':'audio/wav'}).end(tone);return;}
  if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));await page.route('**/cloud.js',r=>r.fulfill({contentType:'text/javascript',body:mock}));await page.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));
  await page.goto('http://127.0.0.1:'+server.address().port+'/');await expect(page.locator('#chat')).toBeVisible();
  const sheet=page.locator('#sheet-layer'),open=async id=>{await page.locator('#message-input').focus();await page.locator('#messages [data-id="'+id+'"] .message-bubble').click({button:'right'});await expect(sheet).toBeVisible();await expect(page.locator('#sheet')).toHaveCSS('opacity','1');};
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
  await open(1);await fits(page);
  assert.match(await sheet.evaluate(n=>getComputedStyle(n).backdropFilter),/blur/);
  assert.equal(await page.locator('#chat').evaluate(n=>n.inert),true);
  assert.equal(await page.locator('#sheet [data-id],#sheet [data-photo],#sheet [data-voice],#sheet video,#sheet audio').count(),0);
  await page.screenshot({path:path.join(root,'test-results/message-menu-mobile.png')});
  await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Реакция 👍',exact:true})).toBeFocused();
  await page.keyboard.press('Shift+Tab');await expect(page.getByRole('button',{name:'Отмена',exact:true})).toBeFocused();
  await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Реакция 👍',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Другой смайл',exact:true}).tap();await fits(page);
  await expect(page.getByRole('button',{name:'Ответить',exact:true})).toHaveCount(0);
  assert.equal(await page.locator('#sheet .emoji-grid button').count(),62);
  await page.screenshot({path:path.join(root,'test-results/message-menu-expanded.png')});
  await page.getByRole('button',{name:'Реакция 🚀',exact:true}).tap();await expect(sheet).toBeHidden();
  assert.deepEqual(await page.evaluate(()=>window.menuTest.reactions),[{id:1,emoji:'🚀'}]);
  await open(1);await page.getByRole('button',{name:'Другой смайл',exact:true}).tap();
  await expect(page.getByRole('button',{name:'Реакция 🚀',exact:true})).toHaveClass(/mine/);
  await page.getByRole('button',{name:'Реакция 🚀',exact:true}).tap();
  assert.deepEqual(await page.evaluate(()=>window.menuTest.reactions.at(-1)),{id:1,emoji:null});
  await open(1);await page.getByRole('button',{name:'Другой смайл',exact:true}).tap();
  await page.getByRole('textbox',{name:'Свой смайл',exact:true}).fill('🧑🏽‍🚀ещё');await page.getByRole('button',{name:'Поставить',exact:true}).tap();
  assert.equal(await page.evaluate(()=>window.menuTest.reactions.at(-1).emoji),'🧑🏽‍🚀');
  await open(1);await page.getByRole('button',{name:'Другой смайл',exact:true}).tap();await page.getByRole('button',{name:'Свернуть реакции',exact:true}).tap();await fits(page);
  await page.keyboard.press('Escape');await expect(sheet).toBeHidden();assert.equal(await page.locator('#chat').evaluate(n=>n.inert),false);
  assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#chat')),true);
  const focusTarget=page.locator('#messages [data-id="1"] .message-bubble');
  await focusTarget.evaluate(n=>{n.tabIndex=-1;n.focus();});await focusTarget.dispatchEvent('contextmenu');await expect(sheet).toBeVisible();await page.keyboard.press('Escape');await expect(focusTarget).toBeFocused();

  // Длинное своё сообщение не выталкивает действия; светлая, тёмная и terminal-темы.
  for(const theme of ['light','dark','terminal']){
   await page.evaluate(theme=>{document.documentElement.dataset.theme=theme==='dark'?'dark':'light';document.documentElement.dataset.skin=theme==='terminal'?'terminal':'';},theme);
   await open(2);await fits(page);await expect(page.getByRole('button',{name:'Изменить',exact:true})).toBeVisible();
   assert.match(await sheet.evaluate(n=>getComputedStyle(n).backdropFilter),/blur/);
   await page.screenshot({path:path.join(root,'test-results/message-menu-'+theme+'.png')});await page.keyboard.press('Escape');
  }
  for(const size of [{width:320,height:568},{width:740,height:320},{width:1280,height:900}]){
   await page.setViewportSize(size);await open(2);await fits(page);await page.getByRole('button',{name:'Другой смайл',exact:true}).click();await fits(page);await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width:390,height:844});await open(1);await page.getByRole('button',{name:'Другой смайл',exact:true}).click();
  // Смещённая visualViewport моделирует клавиатуру iPhone без подмены геометрии меню.
  await page.evaluate(async()=>{window.savedViewport=window.visualViewport;const v=new EventTarget();Object.assign(v,{width:390,height:300,offsetLeft:0,offsetTop:52});Object.defineProperty(window,'visualViewport',{configurable:true,value:v});(await import('/js/message-menu.js')).layoutMessageMenu();});await fits(page);
  await page.getByRole('button',{name:'Свернуть реакции',exact:true}).click();await fits(page);
  await page.evaluate(()=>{Object.defineProperty(window,'visualViewport',{configurable:true,value:window.savedViewport});});await page.keyboard.press('Escape');

  // Удержание именно play-кнопки голосового не начинает звук/повторную загрузку.
  await page.evaluate(()=>{document.documentElement.dataset.skin='';document.documentElement.dataset.theme='light';});
  const voice=page.locator('#messages [data-id="3"] .voice-play');await voice.scrollIntoViewIfNeeded();await page.waitForFunction(()=>window.menuTest.downloads===1);const cdp=await context.newCDPSession(page),box=await voice.boundingBox();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:box.x+box.width/2,y:box.y+box.height/2}]});await page.waitForTimeout(560);await expect(sheet).toBeVisible();await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await voice.evaluate(n=>n.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1})));
  assert.deepEqual(await page.evaluate(()=>({downloads:window.menuTest.downloads,plays:window.menuTest.plays})),{downloads:1,plays:0});await page.keyboard.press('Escape');
  await voice.tap();await page.waitForFunction(()=>window.menuTest.plays===1);await voice.tap();

  await open(2);await page.getByRole('button',{name:'Изменить',exact:true}).click();await expect(sheet).toBeHidden();await expect(page.locator('#context-title')).toContainText('Изменение');await page.locator('#context-cancel').click();
  await open(2);await page.getByRole('button',{name:'Удалить',exact:true}).click();await expect(sheet).toContainText('Удалить сообщение у всех?');await fits(page);await page.getByRole('button',{name:'Отмена',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.menuTest.deleted),[]);
  await open(2);await page.waitForTimeout(460);await page.locator('#sheet-layer').click({position:{x:3,y:3}});await expect(sheet).toBeHidden();

  await open(1);await page.evaluate(async()=>{const {state}=await import('/js/core.js'),{mergeMessages}=await import('/js/messages.js');mergeMessages([{...state.messages.find(m=>m.id===1),deleted:true,rev:100}], 'changed');});await expect(sheet).toBeHidden();
  await open(2);await page.evaluate(async()=>{(await import('/js/messages.js')).openRoom('00000000-0000-4000-8000-000000000002');});await expect(sheet).toBeHidden();
  await page.evaluate(async()=>{(await import('/js/messages.js')).openRoom('main');});
  await open(2);await page.getByRole('button',{name:'Удалить',exact:true}).click();await page.getByRole('button',{name:'Удалить',exact:true}).click();await expect(sheet).toBeHidden();await expect(page.locator('#messages [data-id="2"]')).toHaveClass(/deleted/);assert.deepEqual(await page.evaluate(()=>window.menuTest.deleted),[2]);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

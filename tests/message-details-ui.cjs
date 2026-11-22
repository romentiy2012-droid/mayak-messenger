// Синтетическая переписка: никаких рабочих аккаунтов, файлов или облачных изменений.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..');
const U='00000000-0000-4000-8000-000000000001',A='00000000-0000-4000-8000-000000000002',B='00000000-0000-4000-8000-000000000003',C='00000000-0000-4000-8000-000000000004',LEFT='00000000-0000-4000-8000-000000000099';
const mock=`(()=>{
 const now=new Date().toISOString(),user={id:'${U}',name:'Кэп теста',owner:true,last_read:999,last_seen:now},people=[user,{id:'${A}',name:'Анна',last_read:2,last_seen:now,avatar_icon:'cat'},{id:'${B}',name:'Борис <b>тест</b>',last_read:0,last_seen:now},{id:'${C}',name:'Лена',last_read:0,last_seen:now}];
 const base={created:now,kind:'text',reactions:{},deleted:null};
 const reactions={'${U}':'👍','${A}':'👍','${B}':'❤️','${LEFT}':'👀'};
 const messages=[{...base,id:1,rev:1,user_id:user.id,name:user.name,text:'Своё сообщение',reactions},{...base,id:2,rev:2,user_id:user.id,name:user.name,text:'📷 Фото',kind:'photo',file:'synthetic/photo.png',file_meta:{width:1,height:1},reactions:{...reactions}},{...base,id:3,rev:3,user_id:'${A}',name:'Анна',text:'Чужое сообщение',reactions:{'${B}':'❤️'}},{...base,id:4,rev:4,user_id:user.id,name:user.name,text:'🎤 Голосовое',kind:'voice'},{...base,id:9,rev:9,user_id:user.id,name:user.name,text:'Ещё не прочитано'},{...base,id:20,rev:20,user_id:user.id,name:user.name,text:'Лично Анне',peer_a:'${U}',peer_b:'${A}',reactions:{'${A}':'👍'}},{...base,id:21,rev:21,user_id:user.id,name:user.name,text:'Лично Борису',peer_a:'${U}',peer_b:'${B}'},{...base,id:22,rev:22,user_id:'${A}',name:'Анна',text:'Ответ Анны',peer_a:'${U}',peer_b:'${A}'}];
 const reads=[{user_id:'${A}',peer:'${U}',last_read:0},{user_id:'${B}',peer:'${U}',last_read:999},{user_id:'${A}',peer:'${B}',last_read:999}];
 window.detailsTest={reactions:[],readsPosted:[],downloads:0};
 window.MayakCloud={async api(route,options={}){
  if(route==='session')return {user,room:'Тестовый круг'};
  if(route.startsWith('events')){const {state}=await import('./js/core.js');return {people:state.people.length?state.people:people,messages:state.messages.length?state.messages:messages,reads:state.reads.length?state.reads:reads,direct_full:true};}
  const body=JSON.parse(options.body||'{}');
  if(route==='react'){window.detailsTest.reactions.push(body);const {state}=await import('./js/core.js');const message=state.messages.find(m=>m.id===body.id),next={...message,rev:message.rev+100,reactions:{...message.reactions}};if(body.emoji)next.reactions[user.id]=body.emoji;else delete next.reactions[user.id];return {message:next};}
  if(route==='read')window.detailsTest.readsPosted.push(body);return {};
 },watch(){},stop(){},async download(){window.detailsTest.downloads++;return (await fetch('./synthetic.png')).blob();}};
})();`;
async function fixture(){
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html',file=path.resolve(root,rel);
  if(rel==='synthetic.png'){res.writeHead(200,{'Content-Type':'image/png'}).end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrGkAAAAASUVORK5CYII=','base64'));return;}
  if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'}).end(rel==='cloud.js'?mock:fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  await context.addInitScript(()=>{localStorage.setItem('mayak.push.off','1');localStorage.setItem('mayak.skin','classic');localStorage.setItem('mayak.theme','light');});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port+'/');await expect(page.locator('#chat')).toBeVisible();
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
  return {page,errors,async close(){await browser.close();await new Promise(resolve=>server.close(resolve));}};
 }catch(e){await browser?.close();await new Promise(resolve=>server.close(resolve));throw e;}
}
const row=(page,id)=>page.locator('#messages .message-row[data-id="'+id+'"]');
const layer=page=>page.locator('#message-info-layer');
const names=page=>page.locator('.message-info-name');
const close=page=>page.getByRole('button',{name:'Закрыть список',exact:true}).click();
async function menu(page,id){await row(page,id).locator('.message-bubble').click({button:'right'});await expect(page.locator('#sheet-layer')).toBeVisible();}

test('reaction chips inspect people without changing reactions; filters and live updates work',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;
 try{
  await row(page,2).locator('[data-react="👍"]').tap();await expect(layer(page)).toBeVisible();await expect(names(page)).toHaveText(['Кэп теста · вы','Анна']);
  await expect(page.locator('#viewer-layer')).toBeHidden();assert.equal(await page.evaluate(()=>window.detailsTest.reactions.length),0);
  await page.getByRole('button',{name:'Все реакции: 4',exact:true}).tap();await expect(names(page)).toHaveText(['Кэп теста · вы','Анна','Борис <b>тест</b>','Участник вышел из чата']);assert.equal(await layer(page).locator('.message-info-name b').count(),0);
  await page.getByRole('button',{name:'Показать реакцию ❤️: 1',exact:true}).tap();await expect(names(page)).toHaveText(['Борис <b>тест</b>']);
  await page.evaluate(async id=>{const {state}=await import('./js/core.js');const {mergeMessages}=await import('./js/messages.js');const m=state.messages.find(m=>m.id===2);const next={...m,rev:100,reactions:{...m.reactions}};delete next.reactions[id];mergeMessages([next],'changed');},B);
  await expect(names(page)).toHaveCount(3);await expect(page.getByRole('button',{name:'Все реакции: 3',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.evaluate(async id=>{const {state}=await import('./js/core.js');(await import('./js/messages.js')).memberChanged({...state.people.find(p=>p.id===id),name:'Анна обновлена',avatar_icon:'ship'});},A);
  await expect(names(page)).toContainText(['Кэп теста · вы','Анна обновлена']);
  await page.screenshot({path:path.join(root,'test-results/message-details-reactions.png')});
  await page.keyboard.press('Escape');await expect(layer(page)).toHaveCount(0);assert.equal(await page.locator('#chat').evaluate(n=>n.inert),false);
  await menu(page,2);await page.getByRole('button',{name:'Кто отреагировал',exact:true}).tap();await expect(names(page)).toHaveCount(3);await close(page);
  // Снять свою реакцию по-прежнему можно повторным выбором в меню.
  await menu(page,2);await page.getByRole('button',{name:'Реакция 👍',exact:true}).tap();assert.equal(await page.evaluate(()=>window.detailsTest.reactions.length),1);assert.equal(await page.evaluate(()=>window.detailsTest.reactions[0].emoji),null);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('own read receipts update counts and lists; direct read marks are scoped to the pair',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;
 try{
  const receipt=row(page,1).locator('[data-readers]');await expect(receipt).toHaveAttribute('aria-label','Кто прочитал сообщение: 1');await receipt.tap();await expect(names(page)).toHaveText(['Анна']);
  await page.evaluate(()=>{window.detailsRows=[document.querySelector('#messages [data-id="1"]'),document.querySelector('#messages [data-id="2"]')];});
  await page.evaluate(async id=>{const {state}=await import('./js/core.js');(await import('./js/messages.js')).memberChanged({...state.people.find(p=>p.id===id),last_read:2});},C);
  await expect(names(page)).toHaveText(['Анна','Лена']);await expect(receipt).toHaveAttribute('aria-label','Кто прочитал сообщение: 2');
  assert.equal(await page.evaluate(()=>window.detailsRows.every(node=>node.isConnected)),true);
  await page.screenshot({path:path.join(root,'test-results/message-details-readers.png')});await close(page);await expect(receipt).toBeFocused();
  await row(page,9).locator('[data-readers]').tap();await expect(page.locator('.message-info-empty')).toHaveText('Пока никто не прочитал');await close(page);
  assert.equal(await row(page,3).locator('[data-readers]').count(),0);await menu(page,3);assert.equal(await page.getByRole('button',{name:'Кто прочитал',exact:true}).count(),0);await page.keyboard.press('Escape');
  await menu(page,1);await page.getByRole('button',{name:'Кто прочитал',exact:true}).tap();await expect(names(page)).toHaveCount(2);await close(page);
  await page.evaluate(async id=>(await import('./js/messages.js')).openRoom(id),A);
  await row(page,20).locator('[data-readers]').tap();await expect(names(page)).toHaveCount(0);await expect(page.locator('.message-info-empty')).toHaveText('Пока никто не прочитал');
  await page.evaluate(async ids=>(await import('./js/messages.js')).readChanged({user_id:ids.a,peer:ids.u,last_read:20}),{a:A,u:U});
  await expect(names(page)).toHaveText(['Анна']);await expect(row(page,20).locator('[data-readers]')).toHaveAttribute('aria-label','Кто прочитал сообщение: 1');
  assert.equal(await row(page,22).locator('[data-readers]').count(),0);
  await page.evaluate(async()=>{const {state}=await import('./js/core.js');const {messageReaders,reactionPeople,openMessageDetails}=await import('./js/message-details.js');
   if(messageReaders(state.messages.find(m=>m.id===22)).length)throw Error('Foreign readers leaked');
   if(reactionPeople({id:777,peer_a:'not-me',peer_b:'other',reactions:{'not-me':'👍'}}).length)throw Error('Foreign reaction leaked');
   openMessageDetails(22,'readers');
  });await expect(names(page)).toHaveText(['Анна']);
  await page.evaluate(async()=>{(await import('./js/messages.js')).connection(false);});await expect(page.locator('.message-info-note')).toContainText('Нет связи');
  await page.evaluate(async()=>(await import('./js/messages.js')).openRoom('main'));await expect(layer(page)).toHaveCount(0);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('details fit light, dark, terminal and short viewports; focus and stale-state cleanup',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;
 try{
  await page.evaluate(async()=>{const {state}=await import('./js/core.js');const {mergeMessages}=await import('./js/messages.js');const m=state.messages.find(m=>m.id===1),reactions={...m.reactions};for(let i=0;i<70;i++){const id='synthetic-person-'+i;state.people.push({id,name:'Участник с длинным именем '+i,last_read:1,avatar_icon:'ship'});reactions[id]=i%2?'👍':'🔥';}mergeMessages([{...m,rev:200,reactions}],'changed');});
  for(const skin of ['light','dark','terminal']){
   await page.evaluate(s=>{window.MayakTheme.setSkin(s==='terminal'?'terminal':'classic');if(s!=='terminal')window.MayakTheme.set(s);},skin);
   for(const size of [{width:390,height:844},{width:320,height:568},{width:740,height:320},{width:1280,height:900}]){
    await page.setViewportSize(size);await row(page,1).locator('[data-react="👍"]').click();await expect(layer(page)).toBeVisible();
    const geometry=await page.locator('.message-info-card').evaluate(n=>{const r=n.getBoundingClientRect(),list=n.querySelector('.message-info-list');return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,scroll:list.scrollHeight,client:list.clientHeight};});
    assert.ok(geometry.left>=0&&geometry.right<=size.width&&geometry.top>=0&&geometry.bottom<=size.height,JSON.stringify({size,skin,geometry}));assert.ok(geometry.scroll>geometry.client&&geometry.client>0);
    await expect(page.getByRole('button',{name:'Закрыть список',exact:true})).toBeFocused();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#message-info-layer')),true);await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Закрыть список',exact:true})).toBeFocused();
    if(size.width===390)await page.screenshot({path:path.join(root,'test-results/message-details-'+skin+'.png')});
    await page.keyboard.press('Escape');await expect(layer(page)).toHaveCount(0);assert.equal(await page.locator('#chat').evaluate(n=>n.inert),false);
   }
  }
  await row(page,1).locator('[data-react="👍"]').click();await page.evaluate(async()=>{const {state}=await import('./js/core.js'),m=state.messages.find(m=>m.id===1);(await import('./js/messages.js')).mergeMessages([{...m,rev:300,deleted:true}],'changed');});await expect(layer(page)).toHaveCount(0);
  await row(page,2).locator('[data-readers]').click();await page.evaluate(async()=>(await import('./js/session.js')).showJoin());await expect(layer(page)).toHaveCount(0);await expect(page.locator('#welcome')).toBeVisible();assert.equal(await page.locator('#chat').evaluate(n=>n.inert),false);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

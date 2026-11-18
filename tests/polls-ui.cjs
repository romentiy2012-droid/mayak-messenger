// Настоящий интерфейс Chrome, синтетическое облако; рабочие опросы не создаются.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..');
const OWNER='00000000-0000-4000-8000-000000000001',PEER='00000000-0000-4000-8000-000000000002',GUEST='00000000-0000-4000-8000-000000000003';
const mock=`(()=>{
 const OWNER='${OWNER}',PEER='${PEER}',GUEST='${GUEST}',guest=location.search.includes('guest'),uid=guest?GUEST:OWNER;
 const now=new Date().toISOString(),people=[{id:OWNER,name:'Тестовый владелец',owner:true},{id:PEER,name:'Тестовый собеседник',owner:false},{id:GUEST,name:'Тестовый гость',owner:false}].map(p=>({...p,last_seen:now,online:true,last_read:0})),user=people.find(p=>p.id===uid),clone=v=>JSON.parse(JSON.stringify(v));
 const poll=(id,question,multiple,anonymous,privateRoom=false)=>({id,rev:id,user_id:PEER,name:people[1].name,text:'📊 '+question,kind:'poll',created:now,reactions:{},peer_a:privateRoom?OWNER:null,peer_b:privateRoom?PEER:null,file_meta:{question,multiple,anonymous,total:1,closed_at:null,options:[{id:1,text:'Утром',count:0},{id:2,text:'Вечером',count:1}]}});
 let s=JSON.parse(localStorage.getItem('poll.ui.server')||'null')||{messages:[poll(10,'Анонимный вопрос',false,true),poll(11,'Открытый выбор',true,false),poll(12,'Личный вопрос',false,false,true)],votes:{},requests:{},creates:{},calls:[],next:100,rev:20};
 const save=()=>localStorage.setItem('poll.ui.server',JSON.stringify(s)),find=id=>s.messages.find(m=>m.id===id),allowed=m=>!m.peer_a||[m.peer_a,m.peer_b].includes(uid),mine=id=>s.votes[uid+':'+id]||[];
 function snapshot(m,voters=false){if(!allowed(m))throw Object.assign(Error('Опрос недоступен'),{status:403,code:'42501'});return clone({message:m,mine:mine(m.id),can_close:m.user_id===uid||user.owner&&!m.peer_a,voters:voters?[{id:PEER,name:people[1].name,choices:[2]},...(mine(m.id).length?[{id:uid,name:user.name,choices:mine(m.id)}]:[])]:null})}
 function tally(m){const votes=[[2],...Object.entries(s.votes).filter(([k,v])=>k.endsWith(':'+m.id)&&v.length).map(([,v])=>v)];m.file_meta.total=votes.length;m.file_meta.options.forEach(o=>o.count=votes.filter(v=>v.includes(o.id)).length);m.rev=++s.rev;save();}
 window.pollTest={loseCreate:false,loseVote:false,deferVote:false,release:null,get server(){return clone(s)},notify(){window.pollWatch?.('ready')},otherVote(id){const m=find(id);m.file_meta.total++;m.file_meta.options[1].count++;m.rev=++s.rev;save();window.pollWatch?.('ready')}};
 window.MayakCloud={async api(path,options={}){const route=path.split('?')[0],b=JSON.parse(options.body||'{}');
  if(route==='session')return {user:clone(user),room:'Тестовый круг'};
  if(route==='events')return {people:clone(people),messages:clone(s.messages.filter(allowed)),reads:[],direct_full:true};
  if(route==='poll-get'){s.calls.push({route,body:clone(b)});save();const m=find(b.id);if(b.voters&&m.file_meta.anonymous)throw Error('Must not request anonymous voters');return snapshot(m,b.voters)}
  if(route==='poll-create'){
   s.calls.push({route,body:clone(b)});let m=find(s.creates[b.nonce]);if(!m){m={...poll(s.next++,b.question,b.multiple,b.anonymous),user_id:uid,name:user.name,nonce:b.nonce,rev:++s.rev,reply_to:b.reply||null,peer_a:b.peer?(uid<b.peer?uid:b.peer):null,peer_b:b.peer?(uid<b.peer?b.peer:uid):null};m.file_meta.options=b.options.map((text,i)=>({id:i+1,text,count:0}));m.file_meta.total=0;s.messages.push(m);s.creates[b.nonce]=m.id;}save();if(window.pollTest.loseCreate){window.pollTest.loseCreate=false;throw Error('Lost response')}return snapshot(m);
  }
  if(route==='poll-vote'){
   s.calls.push({route,body:clone(b)});const m=find(b.id),key=uid+':'+b.id+':'+b.nonce;if(!s.requests[key]){s.requests[key]=b.choices;s.votes[uid+':'+b.id]=b.choices;tally(m)}save();const response=snapshot(m);
   if(window.pollTest.loseVote){window.pollTest.loseVote=false;throw Error('Lost vote response')}
   if(window.pollTest.deferVote){window.pollTest.deferVote=false;return new Promise(resolve=>window.pollTest.release=()=>resolve(response))}return response;
  }
  if(route==='poll-close'){const m=find(b.id);m.file_meta.closed_at=now;m.rev=++s.rev;save();return snapshot(m)}
  if(route==='react'){const m=find(b.id);m.reactions[uid]=b.emoji;m.rev=++s.rev;save();return {message:clone(m)}}
  return {};
 },watch(cb){window.pollWatch=cb},stop(){window.pollWatch=null}};
})();`;

// The iOS keyboard shrinks/shifts visualViewport without resizing the layout viewport.
async function checkDialogKeyboard(page){
 await page.evaluate(()=>{
  const view=window.visualViewport,original={height:view.height,offsetTop:view.offsetTop};
  window.keyboardTest={height:view.height,offsetTop:0,original};
  Object.defineProperties(view,{height:{configurable:true,get:()=>window.keyboardTest.height},offsetTop:{configurable:true,get:()=>window.keyboardTest.offsetTop}});
 });
 const viewport=async(height,offsetTop=0,event=true)=>page.evaluate(({height,offsetTop,event})=>{Object.assign(window.keyboardTest,{height,offsetTop});if(event)visualViewport.dispatchEvent(new Event('resize'));},{height,offsetTop,event});
 const visible=async locator=>expect.poll(()=>locator.evaluate(node=>{const r=node.getBoundingClientRect(),card=node.closest('.dialog-card').getBoundingClientRect(),v=visualViewport;return r.top>=Math.max(card.top,v.offsetTop)+8&&r.bottom<=Math.min(card.bottom,v.offsetTop+v.height)-8;})).toBe(true);
 for(let i=3;i<=10;i++)await page.getByRole('button',{name:'＋ Вариант ответа'}).tap();
 const last=page.getByRole('textbox',{name:'Вариант 10',exact:true});await last.fill('Десятый вариант');
 await viewport(344,38);
 await expect.poll(()=>page.locator('.dialog-card').evaluate(n=>n.getBoundingClientRect().bottom<=visualViewport.offsetTop+visualViewport.height)).toBe(true);
 await visible(last);
 await last.press('End');await last.press('!');await expect(last).toHaveValue('Десятый вариант!');
 assert.equal(await last.evaluate(n=>n.selectionStart),16);
 // Next-field navigation does not necessarily cause another viewport event.
 const first=page.getByRole('textbox',{name:'Вариант 1',exact:true});await first.focus();await visible(first);
 await first.press('Tab');await page.keyboard.press('Tab');await visible(page.getByRole('textbox',{name:'Вариант 2',exact:true}));
 await page.getByRole('textbox',{name:'Вопрос опроса'}).focus();await visible(page.getByRole('textbox',{name:'Вопрос опроса'}));
 await last.focus();await visible(last);
 await page.evaluate(()=>{window.MayakTheme.setSkin('classic');window.MayakTheme.set('light')});
 await page.screenshot({path:path.join(root,'test-results/polls-keyboard-light.png'),clip:{x:0,y:38,width:390,height:344}});
 await page.evaluate(()=>window.MayakTheme.set('dark'));await visible(last);
 await page.screenshot({path:path.join(root,'test-results/polls-keyboard-dark.png'),clip:{x:0,y:38,width:390,height:344}});
 await page.evaluate(()=>window.MayakTheme.setSkin('terminal'));await visible(last);
 await page.screenshot({path:path.join(root,'test-results/polls-keyboard-terminal.png'),clip:{x:0,y:38,width:390,height:344}});
 // The form can still be scrolled by hand to its settings and submit button.
 await page.locator('.dialog-card').evaluate(n=>n.scrollTop=n.scrollHeight);
 await page.waitForTimeout(1700);await visible(page.getByRole('button',{name:'Отправить опрос',exact:true}));
 // A delayed/silent Safari geometry update is picked up by the viewport watcher.
 await viewport(300,65,false);await visible(last);
 // A real layout resize (Android/rotation) also keeps the focused option visible.
 await page.setViewportSize({width:844,height:390});await viewport(220,0);await visible(last);
 await page.screenshot({path:path.join(root,'test-results/polls-keyboard-landscape.png'),clip:{x:0,y:0,width:844,height:220}});
 await last.blur();await page.setViewportSize({width:390,height:844});await viewport(844);
 await expect.poll(()=>page.locator('.dialog-card').evaluate(n=>n.clientHeight>500)).toBe(true);
 for(let i=10;i>=3;i--)await page.getByRole('button',{name:'Убрать вариант '+i,exact:true}).tap();
 await expect(first).toHaveValue('Чай');await expect(page.getByRole('textbox',{name:'Вариант 2',exact:true})).toHaveValue('Кофе');
 await page.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;delete window.keyboardTest;visualViewport.dispatchEvent(new Event('resize'));window.MayakTheme.setSkin('terminal')});
}

test('poll UI: create/retry, single/multi choice, privacy, close, drafts and mobile/desktop', {timeout:90000},async()=>{
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html',file=path.resolve(root,relative);if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'});fs.createReadStream(file).pipe(res)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/cloud.js',route=>route.fulfill({contentType:'text/javascript',body:mock}));await page.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));
  const base='http://127.0.0.1:'+server.address().port;await page.goto(base);await expect(page.locator('#chat')).toBeVisible();
  const card=id=>page.locator('.message-row[data-id="'+id+'"] .poll-card'),option=(id,text)=>card(id).getByRole('button',{name:new RegExp(text)});
  await card(10).scrollIntoViewIfNeeded();await expect(option(10,'Утром')).toBeEnabled();await option(10,'Утром').tap();await expect(card(10).locator('.poll-total')).toContainText('2');await expect(option(10,'Утром')).toHaveAttribute('aria-pressed','true');
  await option(10,'Вечером').tap();await expect(option(10,'Вечером')).toHaveAttribute('aria-pressed','true');await card(10).getByRole('button',{name:'Отменить голос',exact:true}).tap();await expect(card(10).locator('.poll-total')).toContainText('1');assert.equal(await card(10).getByRole('button',{name:'Кто голосовал'}).count(),0);
  await page.evaluate(()=>window.pollTest.loseVote=true);await option(10,'Утром').tap();await expect(card(10).getByRole('button',{name:'Повторить голосование'})).toBeVisible();
  await page.reload();await card(10).scrollIntoViewIfNeeded();await expect(card(10).getByRole('button',{name:'Повторить голосование'})).toBeEnabled();await card(10).getByRole('button',{name:'Повторить голосование'}).tap();await expect(card(10).getByRole('button',{name:'Отменить голос',exact:true})).toBeVisible();await expect(card(10).locator('.poll-total')).toContainText('2');
  const votes=await page.evaluate(()=>window.pollTest.server.calls.filter(c=>c.route==='poll-vote'&&c.body.id===10));assert.equal(votes.at(-1).body.nonce,votes.at(-2).body.nonce);
  await card(11).scrollIntoViewIfNeeded();await expect(option(11,'Утром')).toBeEnabled();await option(11,'Утром').tap();await option(11,'Вечером').tap();await card(11).getByRole('button',{name:'Голосовать',exact:true}).tap();await expect(card(11).locator('.poll-total')).toContainText('2');await card(11).getByRole('button',{name:'Кто голосовал'}).tap();await expect(card(11).locator('.poll-voters')).toContainText('Тестовый владелец');
  await card(11).getByRole('button',{name:'Завершить опрос'}).tap();await card(11).getByRole('button',{name:'Да, завершить'}).tap();await expect(card(11).locator('.poll-total')).toContainText('завершено');await expect(option(11,'Утром')).toBeDisabled();
  // Меню вложений сохраняет выбор фото; новый опрос не стирает обычный черновик.
  await page.locator('#attach-button').tap();const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Фото',exact:true}).tap();const picked=await chooser,png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=4;c.getContext('2d').fillRect(0,0,4,4);return c.toDataURL('image/png').split(',')[1]});await picked.setFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await expect(page.locator('#attachment-bar')).toBeVisible();await page.locator('#attachment-cancel').tap();await expect(page.locator('#attachment-bar')).toBeHidden();
  await page.locator('#message-input').fill('Сохранить мой текст');
  const editor=async()=>{await page.locator('#attach-button').tap();await page.getByRole('button',{name:'Опрос',exact:true}).tap();await expect(page.getByRole('heading',{name:'Новый опрос'})).toBeVisible()};
  await editor();await page.getByRole('textbox',{name:'Вопрос опроса'}).fill('Чай или кофе?');await page.getByRole('textbox',{name:'Вариант 1',exact:true}).fill('Чай');await page.getByRole('textbox',{name:'Вариант 2',exact:true}).fill('Кофе');
  await page.getByRole('button',{name:'＋ Вариант ответа'}).tap();await page.getByRole('textbox',{name:'Вариант 3',exact:true}).fill('Вода');await page.getByRole('button',{name:'Убрать вариант 3',exact:true}).tap();
  await checkDialogKeyboard(page);
  await page.screenshot({path:path.join(root,'test-results/polls-editor-mobile.png'),fullPage:true});await page.locator('#dialog-close').tap();await editor();await expect(page.getByRole('textbox',{name:'Вопрос опроса'})).toHaveValue('Чай или кофе?');
  await page.evaluate(()=>window.pollTest.loseCreate=true);await page.getByRole('button',{name:'Отправить опрос',exact:true}).tap();await expect(page.getByRole('button',{name:'Повторить отправку',exact:true})).toBeEnabled();await expect(page.getByRole('textbox',{name:'Вопрос опроса'})).toBeDisabled();
  await page.reload();await editor();await expect(page.getByRole('button',{name:'Повторить отправку',exact:true})).toBeVisible();await page.getByRole('button',{name:'Повторить отправку',exact:true}).tap();await expect(page.locator('#dialog-layer')).toBeHidden();await expect(page.locator('.poll-question').filter({hasText:'Чай или кофе?'})).toHaveCount(1);await expect(page.locator('#message-input')).toHaveValue('Сохранить мой текст');
  const creates=await page.evaluate(()=>window.pollTest.server.calls.filter(c=>c.route==='poll-create'));assert.equal(creates.length,2);assert.deepEqual(creates[0].body,creates[1].body);
  // Внешнее обновление результатов не стирает набранный множественный выбор.
  await editor();await page.getByRole('textbox',{name:'Вопрос опроса'}).fill('Несколько вариантов');await page.getByRole('textbox',{name:'Вариант 1',exact:true}).fill('Один');await page.getByRole('textbox',{name:'Вариант 2',exact:true}).fill('Два');await page.getByText('Можно выбрать несколько ответов',{exact:true}).tap();await page.getByRole('button',{name:'Отправить опрос',exact:true}).tap();
  const multi=await page.evaluate(()=>window.pollTest.server.messages.find(m=>m.file_meta?.question==='Несколько вариантов').id);await expect(option(multi,'Один')).toBeEnabled();await option(multi,'Один').tap();await page.evaluate(id=>window.pollTest.otherVote(id),multi);await expect(card(multi).locator('.poll-total')).toContainText('1');await expect(option(multi,'Один')).toHaveAttribute('aria-pressed','true');
  // Опрос сохраняет исходного адресата даже при смене чата во время редактора.
  await editor();await page.getByRole('textbox',{name:'Вопрос опроса'}).fill('Исходный общий чат');await page.getByRole('textbox',{name:'Вариант 1',exact:true}).fill('Да');await page.getByRole('textbox',{name:'Вариант 2',exact:true}).fill('Нет');await page.evaluate(async peer=>(await import('/js/messages.js')).openRoom(peer),PEER);await page.getByRole('button',{name:'Отправить опрос',exact:true}).tap();
  assert.equal(await page.evaluate(()=>window.pollTest.server.calls.filter(c=>c.route==='poll-create').at(-1).body.peer),null);
  await editor();await page.getByRole('textbox',{name:'Вопрос опроса'}).fill('Наш личный опрос');await page.getByRole('textbox',{name:'Вариант 1',exact:true}).fill('Да');await page.getByRole('textbox',{name:'Вариант 2',exact:true}).fill('Нет');await page.getByRole('button',{name:'Отправить опрос',exact:true}).tap();assert.equal(await page.evaluate(()=>window.pollTest.server.calls.filter(c=>c.route==='poll-create').at(-1).body.peer),PEER);
  await page.screenshot({path:path.join(root,'test-results/polls-mobile-terminal.png'),fullPage:true});
  await page.evaluate(()=>{window.MayakTheme.setSkin('classic');window.MayakTheme.set('dark')});await page.screenshot({path:path.join(root,'test-results/polls-mobile-dark.png'),fullPage:true});
  assert.equal(await page.locator('#messages').evaluate(n=>n.scrollWidth>n.clientWidth),false);
  const anonymousRequests=await page.evaluate(()=>window.pollTest.server.calls.filter(c=>c.route==='poll-get'&&c.body.id===10&&c.body.voters));assert.equal(anonymousRequests.length,0);
  const desktop=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'}),wide=await desktop.newPage();wide.on('pageerror',e=>errors.push(e.message));await wide.route('**/cloud.js',route=>route.fulfill({contentType:'text/javascript',body:mock}));await wide.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));await wide.goto(base+'/?guest');await expect(wide.locator('#chat')).toBeVisible();await expect(wide.locator('.poll-question').filter({hasText:'Личный вопрос'})).toHaveCount(0);assert.equal(await wide.getByRole('button',{name:'Завершить опрос'}).count(),0);await expect(wide.locator('.message-row[data-id=\"10\"] .poll-option').first()).toBeEnabled();await wide.screenshot({path:path.join(root,'test-results/polls-desktop-light.png'),fullPage:true});
  await wide.locator('.message-row[data-id=\"10\"] .poll-question').click({button:'right'});await wide.getByRole('button',{name:'Ответить',exact:true}).click();await expect(wide.locator('#context-text')).toContainText('Анонимный вопрос');await wide.locator('#context-cancel').click();await wide.locator('.message-row[data-id=\"10\"] .poll-question').click({button:'right'});await wide.getByRole('button',{name:'Реакция 👍',exact:true}).click();await expect(wide.locator('.message-row[data-id=\"10\"] .reaction')).toContainText('👍');await wide.locator('#attach-button').click();await wide.getByRole('button',{name:'Опрос',exact:true}).click();await expect(wide.getByRole('textbox',{name:'Вопрос опроса'})).toBeVisible();await wide.getByRole('textbox',{name:'Вопрос опроса'}).fill('Гостевой вопрос');await wide.getByRole('textbox',{name:'Вариант 1',exact:true}).fill('<img src=x onerror=alert(1)>');await wide.getByRole('textbox',{name:'Вариант 2',exact:true}).fill('Обычный');await wide.getByRole('button',{name:'Отправить опрос',exact:true}).click();await expect(wide.locator('.poll-question').filter({hasText:'Гостевой вопрос'})).toHaveCount(1);assert.equal(await wide.locator('.poll-option img').count(),0);
  await page.evaluate(async()=>{(await import('/js/messages.js')).openRoom('main')});await card(10).scrollIntoViewIfNeeded();await expect(option(10,'Вечером')).toBeEnabled();await page.evaluate(()=>window.pollTest.deferVote=true);await option(10,'Вечером').tap();await page.waitForFunction(()=>!!window.pollTest.release);await page.evaluate(async()=>{(await import('/js/session.js')).showJoin();window.pollTest.release()});await expect(page.locator('#messages .poll-card')).toHaveCount(0);assert.deepEqual(errors,[]);await desktop.close();await context.close();
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});

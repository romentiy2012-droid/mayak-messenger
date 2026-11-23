const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),http=require('http'),path=require('path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..');
const mock=`(()=>{
 const now=new Date().toISOString(),user={id:'00000000-0000-4000-8000-000000000001',name:'Тест',owner:false,last_read:0,last_seen:now},peer={id:'00000000-0000-4000-8000-000000000002',name:'Друг',last_read:0,last_seen:now};
 window.stickerTest={uploads:[],posts:[],files:{},id:10};
 window.MayakCloud={async api(route,options={}){
  if(route==='session')return {user,room:'Тест'};
  if(route.startsWith('events'))return {people:[user,peer],messages:[],reads:[],direct_full:true};
  const body=JSON.parse(options.body||'{}');
  if(route==='attach'){window.stickerTest.posts.push(body);return {message:{id:++window.stickerTest.id,rev:window.stickerTest.id,user_id:user.id,name:user.name,created:now,text:body.text||'📷 Фото',kind:body.kind,file:body.file,file_meta:{...body.meta,caption:!!body.text},reactions:{},peer_a:null,peer_b:null}};}
  if(route==='messages')return {message:{id:++window.stickerTest.id,rev:window.stickerTest.id,user_id:user.id,name:user.name,created:now,text:body.text,kind:'text',reactions:{}}};
  return {};
 },watch(){},stop(){},async upload(blob,ext,bucket,prefix=''){const name=user.id+'/'+prefix+'a'.repeat(24)+'.'+ext;window.stickerTest.uploads.push({type:blob.type,size:blob.size,ext,prefix});window.stickerTest.files[name]=blob;return name;},async download(name){return window.stickerTest.files[name];},async removeFile(){}};
})();`;
async function fixture(){
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json','.json':'application/json'};
 const server=http.createServer((req,res)=>{const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html',file=path.resolve(root,rel);if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'}).end(rel==='cloud.js'?mock:fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});await context.addInitScript(()=>{localStorage.setItem('mayak.push.off','1');localStorage.setItem('mayak.skin','classic');});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port+'/');await expect(page.locator('#chat')).toBeVisible();return {page,errors,close:async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));}};}catch(e){await browser?.close();await new Promise(resolve=>server.close(resolve));throw e;}
}
async function transparentPNG(page){return page.evaluate(async()=>{const c=document.createElement('canvas');c.width=100;c.height=80;const x=c.getContext('2d');x.fillStyle='#f00';x.fillRect(30,20,40,40);const blob=await new Promise(r=>c.toBlob(r,'image/png'));return Array.from(new Uint8Array(await blob.arrayBuffer()));});}
async function collection(page){await page.locator('#stickers-button').tap();await expect(page.locator('#expression-panel')).toBeVisible();}
async function manage(page){await page.getByRole('button',{name:'Управление стикерами',exact:true}).tap();await expect(page.locator('.expression-heading')).toHaveText('Мои стикеры');}

test('inline panel: emoji selection, grapheme deletion, Russian search, categories, recents and keyboard',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;try{
  await page.locator('#message-input').fill('AB');await page.locator('#message-input').evaluate(n=>n.setSelectionRange(1,1));
  await collection(page);await expect(page.locator('#dialog-layer')).toBeHidden();
  const geometry=await page.evaluate(()=>{const p=document.querySelector('#expression-panel').getBoundingClientRect(),c=document.querySelector('#message-form').getBoundingClientRect(),s=document.querySelector('#messages-scroll').getBoundingClientRect();return {panel:p.top,composer:c.bottom,history:s.bottom,composerTop:c.top,bottom:p.bottom,height:innerHeight};});
  assert.ok(geometry.panel>=geometry.composer&&geometry.history<=geometry.composerTop&&geometry.bottom<=geometry.height+1,JSON.stringify(geometry));
  await page.getByRole('tab',{name:'Эмодзи',exact:true}).tap();await expect(page.locator('.emoji-pick').first()).toBeVisible();
  const first=await page.locator('.emoji-pick').first().textContent();await page.locator('.emoji-pick').first().tap();await expect(page.locator('#message-input')).toHaveValue('A'+first+'B');await expect(page.locator('#message-input')).not.toBeFocused();
  await page.locator('.emoji-pick').first().tap();await page.getByRole('button',{name:'Удалить последний символ',exact:true}).tap();await expect(page.locator('#message-input')).toHaveValue('A'+first+'B');
  await page.getByRole('button',{name:'Животные и природа',exact:true}).tap();await expect(page.locator('.expression-heading')).toHaveText('Животные и природа');
  await page.getByRole('searchbox',{name:'Поиск в панели'}).fill('кот');await expect(page.locator('.emoji-pick').first()).toBeVisible();assert.ok(await page.locator('.emoji-pick').count()<80);
  await page.getByRole('button',{name:'Недавние эмодзи',exact:true}).tap();await expect(page.locator('.emoji-pick')).toHaveCount(1);
  await page.evaluate(()=>window.MayakTheme.set('light'));await page.screenshot({path:path.join(root,'test-results/expressions-emoji-light.png')});
  await page.getByRole('button',{name:'Вернуться к клавиатуре',exact:true}).tap();await expect(page.locator('#expression-panel')).toBeHidden();await expect(page.locator('#message-input')).toBeFocused();
  await page.reload();await collection(page);await page.getByRole('tab',{name:'Эмодзи',exact:true}).tap();await page.getByRole('button',{name:'Недавние эмодзи',exact:true}).tap();await expect(page.locator('.emoji-pick')).toHaveCount(1);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('personal stickers survive the upgrade; one tap sends, favorites/recent persist and accounts stay isolated',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;try{
  const bytes=await transparentPNG(page);await page.evaluate(async bytes=>{const {addPersonalSticker}=await import('/js/stickers.js'),{state}=await import('/js/core.js');await addPersonalSticker(new Blob([new Uint8Array(bytes)],{type:'image/png'}),state.user.id);},bytes);
  await page.locator('#message-input').fill('Черновик остаётся');await collection(page);await expect(page.locator('.expression-sticker')).toHaveCount(1);
  await page.getByRole('button',{name:'В избранное',exact:true}).tap();await page.getByRole('button',{name:'Избранные стикеры',exact:true}).tap();await expect(page.locator('.expression-sticker')).toHaveCount(1);
  await page.getByRole('button',{name:'Отправить стикер 1',exact:true}).tap();await expect(page.locator('#messages .message-sticker img')).toBeVisible();await expect(page.locator('#message-input')).toHaveValue('Черновик остаётся');await expect(page.locator('#expression-panel')).toBeVisible();
  const sent=await page.evaluate(()=>({uploads:window.stickerTest.uploads,posts:window.stickerTest.posts}));assert.equal(sent.posts.length,1);assert.equal(sent.posts[0].text,'');assert.equal(sent.uploads[0].prefix,'sticker-');
  await page.getByRole('button',{name:'Недавние стикеры',exact:true}).tap();await expect(page.locator('.expression-sticker')).toHaveCount(1);
  await page.screenshot({path:path.join(root,'test-results/expressions-stickers-light.png')});
  await page.reload();await collection(page);await page.getByRole('button',{name:'Избранные стикеры',exact:true}).tap();await expect(page.locator('.expression-sticker')).toHaveCount(1);
  await page.evaluate(async()=>{const {state}=await import('/js/core.js');state.user={...state.user,id:'00000000-0000-4000-8000-000000000099'};document.dispatchEvent(new Event('mayak-context-changed'));});await expect(page.locator('#expression-panel')).toBeHidden();await collection(page);await expect(page.locator('.expression-sticker')).toHaveCount(0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('catalog starts empty, can add a trusted pack later, and ignores external image sources',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;try{
  await page.route('**/assets/sticker-packs.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:1,packs:[]})}));
  await collection(page);await page.getByRole('button',{name:'Каталог наборов',exact:true}).tap();await expect(page.locator('.expression-empty')).toContainText('Наборов пока нет');
  const bytes=Buffer.from(await transparentPNG(page));await page.route('**/assets/sticker-packs.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:1,packs:[{id:'test',title:'Тестовый набор',items:[{url:'assets/stickers/test.png',title:'Тестовый стикер'}]},{id:'bad',title:'Внешний',items:[{url:'https://untrusted.invalid/image.png'}]}]})}));await page.route('**/assets/stickers/test.png',r=>r.fulfill({contentType:'image/png',body:bytes}));
  await page.locator('#stickers-button').tap();await collection(page);await page.getByRole('button',{name:'Каталог наборов',exact:true}).tap();await expect(page.locator('.expression-pack')).toHaveCount(1);await page.getByRole('button',{name:'Добавить',exact:true}).tap();await expect(page.getByRole('button',{name:'Добавлен',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Тестовый набор',exact:true}).tap();await page.getByRole('button',{name:'Тестовый стикер',exact:true}).tap();await expect(page.locator('#messages .message-sticker')).toHaveCount(1);await page.reload();await collection(page);await expect(page.getByRole('button',{name:'Тестовый набор',exact:true})).toBeVisible();assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('management, keyboard image capture and repeated panel opening fit small screens and Safari viewport',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;try{
  await collection(page);await manage(page);const bytes=Buffer.from(await transparentPNG(page));await page.getByLabel('Добавить стикер из файла').setInputFiles({name:'test.png',mimeType:'image/png',buffer:bytes});await expect(page.locator('.expression-sticker')).toHaveCount(1);
  const field=page.getByRole('textbox',{name:'Вставить стикер с клавиатуры'});await field.evaluate(async n=>{const c=document.createElement('canvas');c.width=c.height=16;c.getContext('2d').fillRect(4,4,4,4);const image=document.createElement('img');image.src=c.toDataURL('image/png');n.appendChild(image);n.dispatchEvent(new InputEvent('input',{bubbles:true}));});await expect(page.locator('#messages .message-sticker')).toHaveCount(1);
  await expect(page.locator('.expression-sticker')).toHaveCount(2);await page.getByRole('button',{name:'Удалить стикер 1',exact:true}).tap();await expect(page.locator('.expression-sticker')).toHaveCount(1);
  for(const skin of ['classic','terminal'])for(const theme of ['light','dark']){await page.evaluate(({skin,theme})=>{window.MayakTheme.setSkin(skin);window.MayakTheme.set(theme);},{skin,theme});for(const size of [{width:390,height:844},{width:320,height:568},{width:740,height:320}]){await page.setViewportSize(size);const bounds=await page.locator('#expression-panel').evaluate(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,top:r.top};});assert.ok(bounds.left>=0&&bounds.right<=size.width+1&&bounds.bottom<=size.height+1,JSON.stringify({skin,theme,size,bounds}));}}
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{window.panelScrollResets=0;const original=window.scrollTo;Object.defineProperty(visualViewport,'offsetTop',{configurable:true,value:40});window.scrollTo=(...args)=>{if(!document.querySelector('#expression-panel').hidden)window.panelScrollResets++;else original.apply(window,args);};visualViewport.dispatchEvent(new Event('scroll'));});await page.waitForTimeout(800);assert.equal(await page.evaluate(()=>window.panelScrollResets),0);await page.evaluate(()=>{delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('scroll'));});
  await page.evaluate(()=>{window.MayakTheme.setSkin('classic');window.MayakTheme.set('dark');});await page.screenshot({path:path.join(root,'test-results/expressions-panel-dark.png')});
  for(let i=0;i<3;i++){await page.locator('#stickers-button').tap();await collection(page);}await page.keyboard.press('Escape');await expect(page.locator('#expression-panel')).toBeHidden();assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('paste still previews and cannot send a selected sticker to another chat',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;try{
  const bytes=await transparentPNG(page);await page.evaluate(bytes=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],'test.png',{type:'image/png'}));document.querySelector('#message-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));},bytes);await expect(page.locator('#attachment-title')).toHaveText('Стикер');await page.evaluate(async()=>(await import('/js/messages.js')).openRoom('00000000-0000-4000-8000-000000000002'));await page.locator('#send-button').tap();await expect(page.locator('#send-error')).toContainText('другого чата');assert.equal(await page.evaluate(()=>window.stickerTest.posts.length),0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('animated PNG stickers keep their frames through preparation and send',{timeout:30000},async()=>{
 const f=await fixture(),{page}=f;try{
  const zlib=require('node:zlib'),u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
  const chunk=(type,data)=>{const bytes=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const value of bytes){crc^=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return Buffer.concat([u32(data.length),bytes,u32((crc^0xffffffff)>>>0)]);};
  const ihdr=Buffer.concat([u32(2),u32(2),Buffer.from([8,6,0,0,0])]);
  const control=seq=>{const b=Buffer.alloc(26);b.writeUInt32BE(seq);b.writeUInt32BE(2,4);b.writeUInt32BE(2,8);b.writeUInt16BE(1,20);b.writeUInt16BE(5,22);return b;};
  const pixels=color=>zlib.deflateSync(Buffer.from([0,...color,...color,0,...color,...color]));
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('acTL',Buffer.concat([u32(2),u32(0)])),chunk('fcTL',control(0)),chunk('IDAT',pixels([255,0,0,255])),chunk('fcTL',control(1)),chunk('fdAT',Buffer.concat([u32(2),pixels([0,0,255,255])])),chunk('IEND',Buffer.alloc(0))]);
  const prepared=await page.evaluate(async bytes=>{const result=[];for(const type of ['image/png','image/apng']){const item=await (await import('/js/media.js')).prepareSticker(new Blob([new Uint8Array(bytes)],{type}));result.push(Array.from(new Uint8Array(await item.blob.arrayBuffer())));}await (await import('/js/composer.js')).attachSticker(new Blob([new Uint8Array(bytes)],{type:'image/png'}));return result;},[...bytes]);for(const item of prepared)assert.ok(Buffer.from(item).equals(bytes));
  await page.locator('#send-button').tap();await expect(page.locator('.message-sticker img')).toBeVisible();
  // Canvas drawImage uses the default PNG image; inspect the actually displayed animation.
  const hashes=[];for(let i=0;i<8;i++){const image=await page.locator('.message-sticker img').screenshot();hashes.push(require('node:crypto').createHash('sha256').update(image).digest('hex'));await page.waitForTimeout(80);}assert.ok(new Set(hashes).size>1,'Displayed APNG must change frames');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

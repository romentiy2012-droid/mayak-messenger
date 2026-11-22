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
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html',file=path.resolve(root,rel);if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'}).end(rel==='cloud.js'?mock:fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});await context.addInitScript(()=>{localStorage.setItem('mayak.push.off','1');localStorage.setItem('mayak.skin','classic');});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port+'/');await expect(page.locator('#chat')).toBeVisible();return {page,errors,close:async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));}};}catch(e){await browser?.close();await new Promise(resolve=>server.close(resolve));throw e;}
}
async function transparentPNG(page){return page.evaluate(async()=>{const c=document.createElement('canvas');c.width=100;c.height=80;const x=c.getContext('2d');x.fillStyle='#f00';x.fillRect(30,20,40,40);const blob=await new Promise(r=>c.toBlob(r,'image/png'));return Array.from(new Uint8Array(await blob.arrayBuffer()));});}
async function collection(page){await page.locator('#stickers-button').tap();await expect(page.locator('#dialog-title')).toHaveText('Мои стикеры');}

test('paste sticker, preserve text and transparency, send and save received sticker',{timeout:60000},async()=>{
 const f=await fixture(),{page}=f;
 try{
  const bytes=await transparentPNG(page);await page.locator('#message-input').fill('Текст остаётся');
  await page.evaluate(bytes=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],'sticker.png',{type:'image/png'}));document.querySelector('#message-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));},bytes);
  await expect(page.locator('#attachment-title')).toHaveText('Стикер');
  const alpha=await page.evaluate(async()=>{const {state}=await import('./js/core.js');const bitmap=await createImageBitmap(state.attachment.blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const x=canvas.getContext('2d');x.drawImage(bitmap,0,0);return [x.getImageData(0,0,1,1).data[3],x.getImageData(50,40,1,1).data[3]];});assert.deepEqual(alpha,[0,255]);
  await page.locator('#send-button').tap();await expect(page.locator('#attachment-bar')).toBeHidden();await expect(page.locator('#message-input')).toHaveValue('Текст остаётся');
  const result=await page.evaluate(()=>({uploads:window.stickerTest.uploads,posts:window.stickerTest.posts}));assert.equal(result.uploads[0].prefix,'sticker-');assert.equal(result.uploads[0].type,'image/png');assert.equal(result.posts[0].kind,'photo');assert.equal(result.posts[0].text,'');
  const row=page.locator('#messages .message-row[data-id="11"]');await expect(row.locator('.message-sticker img')).toBeVisible();
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>window.MayakTheme.set(theme),theme);
    const styles=await row.evaluate(node=>{const bubble=getComputedStyle(node.querySelector('.message-bubble')),image=getComputedStyle(node.querySelector('.message-photo'));return {bubble:bubble.backgroundColor,border:bubble.borderTopWidth,shadow:bubble.boxShadow,image:image.backgroundColor};});
    assert.deepEqual(styles,{bubble:'rgba(0, 0, 0, 0)',border:'0px',shadow:'none',image:'rgba(0, 0, 0, 0)'});
    await page.screenshot({path:path.join(root,'test-results/sticker-transparent-'+theme+'.png')});
  }
  await row.locator('.message-bubble').click({button:'right'});await page.getByRole('button',{name:'Сохранить как стикер'}).tap();await expect(page.locator('#toast')).toContainText('Стикер сохранён');
  await collection(page);await expect(page.locator('.sticker-tile')).toHaveCount(1);await page.screenshot({path:path.join(root,'test-results/stickers-collection.png')});
  await page.getByRole('button',{name:'Выбрать стикер 1'}).tap();await expect(page.locator('#dialog-layer')).toBeHidden();await expect(page.locator('#attachment-title')).toHaveText('Стикер');await page.locator('#attachment-cancel').tap();
  await page.reload();await expect(page.locator('#chat')).toBeVisible();await collection(page);await expect(page.locator('.sticker-tile')).toHaveCount(1);await page.getByRole('button',{name:'Удалить стикер 1'}).tap();await expect(page.locator('.sticker-tile')).toHaveCount(0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('collection accepts image, prevents accidental replacement and isolates accounts',{timeout:60000},async()=>{
 const f=await fixture(),{page}=f;
 try{
  const bytes=Buffer.from(await transparentPNG(page));await collection(page);await page.locator('.dialog-card input[type=file]').setInputFiles({name:'image.png',mimeType:'image/png',buffer:bytes});await expect(page.locator('.sticker-tile')).toHaveCount(1);
  await page.locator('.dialog-card input[type=file]').setInputFiles({name:'image.png',mimeType:'image/png',buffer:bytes});await expect(page.locator('.sticker-tile')).toHaveCount(1);
  await page.getByRole('button',{name:'Выбрать стикер 1'}).tap();await expect(page.locator('#attachment-title')).toHaveText('Стикер');
  await page.evaluate(bytes=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],'again.png',{type:'image/png'}));document.querySelector('#message-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));},[...bytes]);await expect(page.locator('#toast')).toContainText('Сначала отправьте');await expect(page.locator('#attachment-title')).toHaveText('Стикер');
  await page.locator('#attachment-cancel').tap();await collection(page);await page.evaluate(async()=>{const {state}=await import('./js/core.js');state.user={...state.user,id:'00000000-0000-4000-8000-000000000099'};document.dispatchEvent(new Event('mayak-context-changed'));});await expect(page.locator('#dialog-layer')).toBeHidden();
  await collection(page);await expect(page.locator('.sticker-tile')).toHaveCount(0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('keyboard image insertion in the rich sticker field attaches an image',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;
 try{
  await collection(page);const field=page.getByRole('textbox',{name:'Вставить стикер с клавиатуры'});await expect(field).toBeVisible();
  await field.evaluate(async node=>{const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillRect(4,4,4,4);const img=document.createElement('img');img.src=canvas.toDataURL('image/png');node.appendChild(img);node.dispatchEvent(new InputEvent('input',{bubbles:true}));});
  await expect(page.locator('#dialog-layer')).toBeHidden();await expect(page.locator('#attachment-title')).toHaveText('Стикер');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('a selected sticker cannot be accidentally sent to another conversation',{timeout:45000},async()=>{
 const f=await fixture(),{page}=f;
 try{
  const bytes=await transparentPNG(page);await page.evaluate(bytes=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],'sticker.png',{type:'image/png'}));document.querySelector('#message-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));},bytes);
  await expect(page.locator('#attachment-title')).toHaveText('Стикер');await page.evaluate(async()=>(await import('./js/messages.js')).openRoom('00000000-0000-4000-8000-000000000002'));
  await page.locator('#send-button').tap();await expect(page.locator('#send-error')).toContainText('другого чата');assert.equal(await page.evaluate(()=>window.stickerTest.posts.length),0);assert.equal(await page.evaluate(()=>window.stickerTest.uploads.length),0);await expect(page.locator('#attachment-title')).toHaveText('Стикер');
 }finally{await f.close();}
});

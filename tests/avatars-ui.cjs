// Изолированный браузерный сценарий: настоящие модули интерфейса, облако заменено заглушкой.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium,expect}=require('@playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const mock=`(() => {
 const owner='00000000-0000-4000-8000-000000000001', guest='00000000-0000-4000-8000-000000000002';
 const me=new URLSearchParams(location.search).has('guest')?guest:owner;
 const saved=JSON.parse(localStorage.getItem('test.profile')||'null');
 const people=[{id:owner,name:'Кэп',owner:true,avatar_icon:null,avatar_file:null},{id:guest,name:'Катя',owner:false,avatar_icon:'owl',avatar_file:null}].map(p=>({...p,last_seen:new Date().toISOString(),online:true,last_read:0,typing:null,...(saved&&saved.id===p.id?saved:{})}));
 let callback=null;
 window.mock={people,fail:false,uploads:[],removed:[],emit(row){const i=people.findIndex(p=>p.id===row.id);people[i]={...people[i],...row};callback?.('member',people[i]);}};
 const api=async(path,options={})=>{
  const route=path.split('?')[0],body=JSON.parse(options.body||'{}');
  if(route==='session')return {user:people.find(p=>p.id===me),room:'Наш круг'};
  if(route==='events')return {people:people.map(p=>({...p})),reads:[],messages:[{id:1,rev:1,user_id:guest,name:'Катя',text:'Проверяем аватарки',nonce:'1',kind:'text',created:new Date().toISOString(),reactions:{},peer_a:null},{id:2,rev:2,user_id:owner,name:'Кэп',text:'Свои на связи',nonce:'2',kind:'text',created:new Date().toISOString(),reactions:{},peer_a:null}]};
  if(route==='profile'){
   if(window.mock.fail){window.mock.fail=false;throw Object.assign(new Error('Не удалось сохранить профиль. Повторите.'),{status:503});}
   const i=people.findIndex(p=>p.id===me);people[i]={...people[i],...body};localStorage.setItem('test.profile',JSON.stringify(people[i]));return {user:people[i]};
  }
  if(route==='logout')return {};
  return {};
 };
 window.MayakCloud={api,watch(fn){callback=fn;},stop(){callback=null;},
  async avatarUpload(blob){const file=me+'/'+'a'.repeat(24)+'.jpg';window.mock.uploads.push({size:blob.size,type:blob.type});return file;},
  async avatarDownload(file){if(file.includes('missing'))throw Error('Missing');const svg='<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384"><rect width="384" height="384" fill="#d7935b"/><circle cx="192" cy="180" r="110" fill="#355c6d"/></svg>';return new Blob([svg],{type:'image/svg+xml'});},
  async avatarRemove(file){window.mock.removed.push(file);}
 };
})();`;

test('mobile and desktop avatars: presets, cancel, photo, retry, reset, realtime and guest', {timeout:90000},async()=>{
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),relative=decodeURIComponent(url.pathname)==='/'?'index.html':decodeURIComponent(url.pathname).slice(1),file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/cloud.js',route=>route.fulfill({contentType:'text/javascript',body:mock}));
  await page.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));
  const base='http://127.0.0.1:'+server.address().port+'/';
  await page.goto(base);
  await expect(page.locator('#chat')).toBeVisible();
  await expect(page.locator('.message-row:not(.own)>.avatar')).toHaveText('🦉');
  const open=()=>page.locator('#mobile-profile').click();
  await open(); await expect(page.locator('.avatar-option')).toHaveCount(24);
  await page.getByRole('button',{name:'Кот',exact:true}).click();
  await page.getByRole('button',{name:'Сохранить профиль',exact:true}).click();
  await expect(page.locator('#dialog-layer')).toBeHidden();
  await expect(page.locator('#mobile-avatar')).toHaveText('🐱');
  await page.reload(); await expect(page.locator('#mobile-avatar')).toHaveText('🐱');
  await open();await page.getByRole('button',{name:'Лиса',exact:true}).click();await page.locator('#dialog-close').click();
  await expect(page.locator('#mobile-avatar')).toHaveText('🐱');
  await open();
  await page.locator('.avatar-editor input[type=file]').setInputFiles({name:'photo.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#d7935b"/><circle cx="400" cy="200" r="140" fill="#355c6d"/></svg>')});
  await expect(page.locator('.avatar-preview img')).toBeVisible();
  assert.deepEqual(await page.locator('.avatar-preview img').evaluate(image=>[image.naturalWidth,image.naturalHeight]),[384,384]);
  assert.equal(await page.locator('#dialog-content').evaluate(node=>node.scrollWidth>node.clientWidth),false);
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
  await page.screenshot({path:path.join(root,'test-results/avatars-mobile-terminal.png')});
  await page.evaluate(()=>window.mock.fail=true);
  await page.getByRole('button',{name:'Сохранить профиль',exact:true}).click();
  await expect(page.locator('.profile-in-dialog>.form-error')).toContainText('Не удалось сохранить');
  await page.getByRole('button',{name:'Сохранить профиль',exact:true}).click();
  await expect(page.locator('#dialog-layer')).toBeHidden();await expect(page.locator('#mobile-avatar img')).toBeVisible();
  const uploads=await page.evaluate(()=>window.mock.uploads);assert.equal(uploads.length,1);assert.equal(uploads[0].type,'image/jpeg');assert.ok(uploads[0].size<512000);
  await page.reload();await expect(page.locator('#mobile-avatar img')).toBeVisible();
  await page.evaluate(()=>window.mock.emit({id:window.mock.people[1].id,avatar_icon:'heart'}));
  await expect(page.locator('.message-row:not(.own)>.avatar')).toHaveText('❤️');
  await page.evaluate(()=>window.mock.emit({id:window.mock.people[0].id,avatar_icon:'car',avatar_file:null}));
  await expect(page.locator('#mobile-avatar')).toHaveText('🚗'); // мой профиль изменён на другом устройстве
  await open();await page.getByRole('button',{name:'Оставить буквы',exact:true}).click();
  await page.getByRole('button',{name:'Сохранить профиль',exact:true}).click();await expect(page.locator('#mobile-avatar')).toHaveText('К');
  await page.evaluate(()=>window.mock.emit({id:window.mock.people[1].id,avatar_icon:null,avatar_file:'missing.jpg'}));
  await expect(page.locator('.message-row:not(.own)>.avatar')).toHaveText('К'); // недоступное фото → буквы
  await page.setViewportSize({width:1280,height:900});await page.locator('#profile-button').click();
  await page.evaluate(()=>window.MayakTheme.setSkin('classic'));
  await page.screenshot({path:path.join(root,'test-results/avatars-desktop.png')});
  await page.locator('#dialog-close').click();
  await page.goto(base+'?guest=1');await page.setViewportSize({width:390,height:844});
  await open();await page.getByRole('button',{name:'Машина',exact:true}).click();
  await page.getByRole('button',{name:'Сохранить профиль',exact:true}).click();await expect(page.locator('#mobile-avatar')).toHaveText('🚗');
  await open();await page.screenshot({path:path.join(root,'test-results/avatars-mobile-classic.png')});
  assert.equal(await page.locator('#dialog-content').evaluate(node=>node.scrollWidth>node.clientWidth),false);
  assert.deepEqual(errors,[]);
 } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});

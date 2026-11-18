// Настоящий интерфейс и Chrome; только синтетические метаданные и заглушка облака.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..');
const mock=`(() => {
 const people=Array.from({length:7},(_,i)=>({id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),name:i?'Тестовый участник '+i:'Тестовый владелец',owner:i===0,last_read:0,online:true,last_seen:new Date().toISOString(),avatar_file:null,avatar_icon:null}));
 const guest=new URLSearchParams(location.search).has('guest'),user=people[guest?1:0],labels={video:'Видеокружочек',photo:'Фото',source:'Исходная запись',voice:'Голосовое',avatar:'Аватарка',other:'Файл'};
 const kinds=['video','photo','source','voice','avatar','other'];
 let files=Array.from({length:82},(_,i)=>({id:'file-'+(i+1),version:'version-'+(i+1),kind:kinds[i%6],bytes:(82-i)*100000,created_at:'2026-11-17T12:00:00Z',label:labels[kinds[i%6]]+' '+(i+1),scope:i%3===0?'direct':i%3===1?'main':'unused',can_delete:i!==2,...(i===2?{reason:'Идёт обработка записи'}:{})}));
 const clone=value=>JSON.parse(JSON.stringify(value)),plans=new Map();let unknown=false,stale=false,usageOverride=null;
 window.storageTest={requests:[],deletes:[],removals:0,forbidden:false,failId:null,loseNext:false,conflictNext:false,conflictWithPending:false,failHttpNext:false,reservedId:null,deferNext:false,release:null,unknown(value){unknown=value;},stale(value){stale=value;},usage(value){usageOverride=value;}};
 function overview(body){
  const all=clone(files);if(unknown&&all.length)all[0].bytes=null;
  const used=usageOverride??all.reduce((sum,item)=>sum+(item.bytes||0),0),unknownCount=all.filter(item=>item.bytes===null).length,filtered=all.filter(item=>!body.filter||body.filter==='all'||body.filter==='unused'&&item.scope==='unused'||body.filter===item.kind),offset=body.offset||0;
  const pending=Array.from(plans.values()).find(plan=>plan.items.some(item=>item.status!=='deleted'));
  return {observed_at:'2026-11-18T08:00:00Z',storage:{used_bytes:used,quota_bytes:1000000000,free_bytes:unknownCount?null:Math.max(0,1000000000-used),objects_count:all.length,unknown_size_count:unknownCount,quota_verified_at:'2026-11-18',quota_scope:'organization',breakdown:kinds.map(category=>({category,bytes:all.filter(item=>item.kind===category).reduce((sum,item)=>sum+(item.bytes||0),0),count:all.filter(item=>item.kind===category).length}))},items:filtered.slice(offset,offset+50),has_more:offset+50<filtered.length,total_count:filtered.length,offset,pending_operation:pending?clone(pending):null,traffic:{status:stale?'stale':'unavailable',uncached_quota_bytes:5000000000,cached_quota_bytes:5000000000,used_bytes:stale?250000000:null,observed_at:stale?'2026-11-01T08:00:00Z':null,reason:'Точный расход доступен в разделе Usage.'},usage_url:'https://supabase.com/dashboard/org/test-org/usage'};
 }
 window.MayakCloud={
  async api(path,options={}){
   const route=path.split('?')[0],body=JSON.parse(options.body||'{}');
   if(route==='session')return {user:clone(user),room:'Тестовый круг'};
   if(route==='events')return {people:clone(people),messages:[],reads:[]};
   if(route==='storage'){
    window.storageTest.requests.push(clone(body));
    if(guest||window.storageTest.forbidden)throw Object.assign(Error('Доступ к хранилищу разрешён только владельцу.'),{status:403});
    if(body.action==='overview'){
     const result=overview(body);
     if(window.storageTest.deferNext){window.storageTest.deferNext=false;return new Promise(resolve=>{window.storageTest.release=()=>{window.storageTest.release=null;resolve(result);};});}
     return result;
    }
    if(body.action==='delete'){
     window.storageTest.deletes.push(clone(body));
     if(window.storageTest.conflictNext){window.storageTest.conflictNext=false;files.find(file=>file.id===body.items[0].id).version+='-changed';throw Object.assign(Error('Список файлов изменился.'),{status:409});}
     if(window.storageTest.conflictWithPending){
      window.storageTest.conflictWithPending=false;const file=files.find(file=>file.id==='file-7'),nonce='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';file.can_delete=false;file.reason='Незавершённое удаление';window.storageTest.reservedId=file.id;
      plans.set(nonce,{id:nonce,nonce,items:[{id:file.id,version:file.version,bytes:file.bytes,status:'cleaning'}]});throw Object.assign(Error('Нужно продолжить ранее начатую операцию.'),{status:409});
     }
     if(window.storageTest.failHttpNext){window.storageTest.failHttpNext=false;throw Object.assign(Error('Обработчик временно недоступен.'),{status:502});}
     const signature=JSON.stringify(body.items);if(plans.has(body.nonce)&&JSON.stringify(plans.get(body.nonce).items.map(({id,version})=>({id,version})))!==signature)throw Object.assign(Error('Набор операции изменился.'),{status:409});
     if(!plans.has(body.nonce))plans.set(body.nonce,{id:body.nonce,nonce:body.nonce,items:body.items.map(item=>({...item,bytes:files.find(file=>file.id===item.id)?.bytes??null,status:'pending'}))});
     const plan=plans.get(body.nonce);
     const outcomes=[];
     for(const item of body.items){const file=files.find(file=>file.id===item.id);if(window.storageTest.failId===item.id){window.storageTest.failId=null;outcomes.push({id:item.id,status:'failed',error:'Временная ошибка удаления'});}else if(file&&!file.can_delete&&file.id!==window.storageTest.reservedId){outcomes.push({id:item.id,status:'failed',error:'Идёт обработка записи'});}else{if(file)window.storageTest.removals++;files=files.filter(file=>file.id!==item.id);outcomes.push({id:item.id,status:'deleted'});}}
     for(const outcome of outcomes)plan.items.find(item=>item.id===outcome.id).status=outcome.status;
     // Object removal may finish while its final database acknowledgment is lost.
     if(window.storageTest.loseNext){window.storageTest.loseNext=false;plan.items.at(-1).status='cleaning';throw Error('Lost response after server commit');}
     const response={operation:{id:body.nonce,items:outcomes},...overview(body)};
     return response;
    }
   }
   return {};
  },watch(){},stop(){},async download(){throw Error('Storage UI must not download content');},async videoDownload(){throw Error('Storage UI must not download content');},async avatarDownload(){throw Error('Storage UI must not download content');}
 };
})();`;

test('admin storage: metrics, private metadata, selection, safe retry, lifecycle and mobile/desktop access', {timeout:90000},async()=>{
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost'),relative=decodeURIComponent(url.pathname)==='/'?'index.html':decodeURIComponent(url.pathname).slice(1),file=path.resolve(root,relative);if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[],contentRequests=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/\/storage\/v1\//.test(request.url()))contentRequests.push(request.url());});
  await page.route('**/cloud.js',route=>route.fulfill({contentType:'text/javascript',body:mock}));await page.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));
  const base='http://127.0.0.1:'+server.address().port+'/';await page.goto(base);await expect(page.locator('#chat')).toBeVisible();
  const open=async(wait=true)=>{await page.locator('#more-button').tap();await page.getByRole('button',{name:'Хранилище и лимиты',exact:true}).tap();await expect(page.locator('.storage-window')).toBeVisible();if(wait)await expect(page.getByRole('combobox',{name:'Вид файлов'})).toBeEnabled();};
  const close=()=>page.locator('#dialog-close').click(),refresh=async()=>{await page.getByRole('button',{name:'Обновить',exact:true}).click();await expect(page.getByRole('combobox',{name:'Вид файлов'})).toBeEnabled();};
  const check=label=>page.getByRole('checkbox',{name:'Выбрать: '+label,exact:true});
  await open();await expect(page.locator('.storage-file')).toHaveCount(50);
  await expect(page.locator('.storage-card').first()).toContainText('Занято: 340,3 МБ');await expect(page.locator('.storage-free')).toHaveText('Запас до лимита по файлам Маяка: 659,7 МБ из 1 ГБ');
  await expect(page.locator('.storage-card').first()).toContainText('Лимит общий для организации');await expect(page.locator('.storage-card').first()).toContainText('не среднемесячный');
  await expect(page.locator('.storage-card').first().locator('.about-note').filter({hasText:'Лимит проверен:'})).toHaveText(/Лимит проверен: 18\.11\.(?:20)?26$/);
  await expect(page.locator('.storage-card').nth(1)).toContainText('Точный расход недоступен');await expect(page.locator('.storage-card').nth(1)).not.toContainText('Использовано: 0');
  await expect(page.locator('.storage-quota')).toHaveText(['Без кэша: до 5 ГБ','Из кэша: до 5 ГБ']);await expect(page.getByRole('link',{name:'Открыть точный расход в Supabase'})).toHaveAttribute('href','https://supabase.com/dashboard/org/test-org/usage');
  await expect(page.locator('.storage-observed')).toContainText(/18\.11\.(?:20)?26/);await expect(check('Исходная запись 3')).toBeDisabled();await expect(page.locator('.storage-files')).toContainText('Идёт обработка записи');
  assert.equal(await page.locator('#dialog-content').evaluate(node=>node.scrollWidth>node.clientWidth),false);assert.equal(await page.locator('.storage-window img,.storage-window video,.storage-window audio').count(),0);
  assert.ok((await page.getByRole('combobox',{name:'Вид файлов'}).boundingBox()).width>=150,'file filter retains a usable mobile width');
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});await page.screenshot({path:path.join(root,'test-results/storage-mobile-terminal.png')});
  await page.evaluate(()=>window.storageTest.usage(900000000));await refresh();await expect(page.locator('.storage-limit-high')).toContainText('90%');await page.locator('.storage-card').first().screenshot({path:path.join(root,'test-results/storage-mobile-limit.png')});
  await page.evaluate(()=>window.storageTest.usage(800000000));await refresh();await expect(page.locator('.storage-limit-near')).toContainText('80%');
  await page.evaluate(()=>window.storageTest.usage(1000000000));await refresh();await expect(page.locator('.storage-limit-full')).toContainText('достигнут или превышен');
  await page.evaluate(()=>window.storageTest.usage(null));await refresh();await expect(page.locator('.storage-limit-note')).toHaveCount(0);

  await page.getByRole('button',{name:'Выбрать на странице',exact:true}).click();await expect(page.locator('.storage-selection-count')).toContainText('Выбрано: 20');assert.equal(await page.locator('.storage-files input:checked').count(),20);
  await page.getByRole('button',{name:'Далее',exact:true}).click();await expect(page.locator('.storage-file')).toHaveCount(32);await expect(page.locator('.storage-selection-count')).toContainText('Выбрано: 20');await expect(page.locator('.storage-files input').first()).toBeDisabled();
  await page.getByRole('button',{name:'Назад',exact:true}).click();await expect(page.locator('.storage-file')).toHaveCount(50);assert.equal(await page.locator('.storage-files input:checked').count(),20);
  await page.getByRole('button',{name:'Снять выбор',exact:true}).click();await check('Видеокружочек 1').check();await check('Фото 2').check();
  await page.getByRole('button',{name:'Удалить выбранные',exact:true}).click();await expect(page.locator('.storage-confirm')).toContainText('для всех участников');await expect(page.locator('.storage-confirm')).toContainText('Текст сообщений останется');await expect(page.locator('.storage-confirm')).toContainText('Отменить удаление нельзя');
  await page.getByRole('button',{name:'Не удалять',exact:true}).click();assert.equal(await page.evaluate(()=>window.storageTest.deletes.length),0);
  await page.evaluate(()=>window.storageTest.failId='file-2');await page.getByRole('button',{name:'Удалить выбранные',exact:true}).click();await page.getByRole('button',{name:'Удалить безвозвратно',exact:true}).click();
  await expect(page.locator('.storage-error')).toContainText('Не удалено файлов: 1');await expect(page.locator('.storage-card').first()).toContainText('Занято: 332,1 МБ');await expect(page.locator('.storage-selection-count')).toContainText('Выбрано: 1');await expect(check('Фото 2')).toBeChecked();await expect(check('Фото 2')).toBeDisabled();await expect(page.getByRole('button',{name:'Снять выбор',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Повторить удаление',exact:true}).click();await expect(page.locator('.storage-status')).toContainText('Удаление завершено');await expect(page.locator('.storage-card').first()).toContainText('Занято: 324 МБ');
  const partial=await page.evaluate(()=>window.storageTest.deletes);assert.equal(partial.length,2);assert.equal(partial[0].nonce,partial[1].nonce);assert.deepEqual(partial[0].items,partial[1].items);assert.deepEqual(partial[0].items,[{id:'file-1',version:'version-1'},{id:'file-2',version:'version-2'}]);

  await check('Голосовое 4').check();await check('Аватарка 5').check();await page.evaluate(()=>window.storageTest.loseNext=true);await page.getByRole('button',{name:'Удалить выбранные',exact:true}).click();await page.getByRole('button',{name:'Удалить безвозвратно',exact:true}).click();
  await expect(page.locator('.storage-error')).toContainText('Не удалось получить результат');await expect(page.locator('.storage-card').first()).toContainText('Занято: 324 МБ');
  await close();await open();await expect(page.locator('.storage-selection-count')).toContainText('Выбрано: 1');await expect(page.getByRole('button',{name:'Повторить удаление',exact:true})).toBeVisible();await expect(page.locator('.storage-card').first()).toContainText('Занято: 308,3 МБ');
  await page.getByRole('button',{name:'Повторить удаление',exact:true}).click();await expect(page.locator('.storage-card').first()).toContainText('Занято: 308,3 МБ');await expect(page.getByRole('button',{name:'Повторить удаление',exact:true})).toBeHidden();
  const lost=await page.evaluate(()=>window.storageTest.deletes.slice(-2));assert.equal(lost[0].nonce,lost[1].nonce);assert.deepEqual(lost[0].items,lost[1].items);assert.deepEqual(lost[1].items,[{id:'file-4',version:'version-4'},{id:'file-5',version:'version-5'}]);

  // A stale selection rolls back prepare with 409; no object has been removed and selection unlocks.
  const beforeConflict=await page.evaluate(()=>window.storageTest.removals);await check('Файл 6').check();await page.evaluate(()=>window.storageTest.conflictNext=true);await page.getByRole('button',{name:'Удалить выбранные',exact:true}).click();await page.getByRole('button',{name:'Удалить безвозвратно',exact:true}).click();
  await expect(page.locator('.storage-error')).toContainText('Список изменился. Выбери файлы снова.');await expect(page.getByRole('button',{name:'Повторить удаление',exact:true})).toBeHidden();await expect(page.locator('.storage-selection-count')).toHaveText('Выбери файлы для удаления');assert.equal(await page.evaluate(()=>window.storageTest.removals),beforeConflict);
  await expect(check('Файл 6')).toBeEnabled();await check('Файл 6').check();await expect(page.getByRole('button',{name:'Снять выбор',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Снять выбор',exact:true}).click();

  // A different committed operation may be returned by the 409 refresh; resume its original plan.
  await check('Файл 6').check();await page.evaluate(()=>window.storageTest.conflictWithPending=true);await page.getByRole('button',{name:'Удалить выбранные',exact:true}).click();await page.getByRole('button',{name:'Удалить безвозвратно',exact:true}).click();
  await expect(page.locator('.storage-error')).toContainText('Восстановлено незавершённое удаление');await expect(check('Файл 6')).not.toBeChecked();await expect(check('Видеокружочек 7')).toBeChecked();await expect(check('Видеокружочек 7')).toBeDisabled();assert.equal(await page.evaluate(()=>window.storageTest.removals),beforeConflict);
  await page.getByRole('button',{name:'Повторить удаление',exact:true}).click();await expect(page.getByRole('button',{name:'Повторить удаление',exact:true})).toBeHidden();
  const recovered=await page.evaluate(()=>window.storageTest.deletes.at(-1));assert.equal(recovered.nonce,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');assert.deepEqual(recovered.items,[{id:'file-7',version:'version-7'}]);

  // A 502 is ambiguous: preserve the plan and its versions instead of treating it like 409.
  await check('Файл 6').check();const before502=await page.locator('.storage-card').first().locator('.storage-number').textContent(),overviews=await page.evaluate(()=>window.storageTest.requests.filter(request=>request.action==='overview').length);await page.evaluate(()=>window.storageTest.failHttpNext=true);await page.getByRole('button',{name:'Удалить выбранные',exact:true}).click();await page.getByRole('button',{name:'Удалить безвозвратно',exact:true}).click();
  await expect(page.locator('.storage-error')).toContainText('временно недоступен');await expect(page.getByRole('button',{name:'Повторить удаление',exact:true})).toBeVisible();await expect(page.locator('.storage-card').first().locator('.storage-number')).toHaveText(before502);assert.equal(await page.evaluate(()=>window.storageTest.requests.filter(request=>request.action==='overview').length),overviews);
  await page.getByRole('button',{name:'Повторить удаление',exact:true}).click();await expect(page.getByRole('button',{name:'Повторить удаление',exact:true})).toBeHidden();const unavailable=await page.evaluate(()=>window.storageTest.deletes.slice(-2));assert.equal(unavailable[0].nonce,unavailable[1].nonce);assert.deepEqual(unavailable[0].items,unavailable[1].items);assert.deepEqual(unavailable[1].items,[{id:'file-6',version:'version-6-changed'}]);

  await page.getByRole('combobox',{name:'Вид файлов'}).selectOption('source');await expect(page.locator('.storage-file')).toHaveCount(14);await expect(page.locator('.storage-file').first()).toContainText('Исходная запись');
  await page.getByRole('combobox',{name:'Вид файлов'}).selectOption('all');await page.evaluate(()=>{window.storageTest.unknown(true);window.storageTest.stale(true);});await refresh();
  await expect(page.locator('.storage-free')).toContainText('Запас до лимита по файлам Маяка: неизвестно');await expect(page.locator('.storage-card').first()).toContainText('Известный объём');await expect(page.locator('.storage-card').nth(1)).toContainText('Устаревший снимок');await expect(page.locator('.storage-card').nth(1)).toContainText(/01\.11\.(?:20)?26/);
  await page.evaluate(()=>{window.storageTest.unknown(false);window.storageTest.stale(false);window.MayakTheme.setSkin('classic');window.MayakTheme.set('dark');});await refresh();await page.locator('.storage-toolbar').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'test-results/storage-mobile-dark.png')});
  await close();await page.evaluate(()=>window.storageTest.forbidden=true);await open();await expect(page.locator('.storage-error')).toContainText('только владельцу');await expect(page.locator('.storage-file')).toHaveCount(0);await expect(page.locator('#offline-banner')).toBeHidden();await close();await page.evaluate(()=>window.storageTest.forbidden=false);

  // The shared dialog DOM must not accept an old administrator response after closing/reopening.
  await page.evaluate(()=>window.storageTest.deferNext=true);await open(false);await page.waitForFunction(()=>typeof window.storageTest.release==='function');await close();await page.locator('#more-button').tap();await page.getByRole('button',{name:'Профиль, участники и пароли',exact:true}).tap();await expect(page.locator('#dialog-title')).toHaveText('Ваш круг');await page.evaluate(()=>window.storageTest.release());await page.waitForTimeout(100);await expect(page.locator('.storage-window')).toHaveCount(0);await expect(page.locator('#dialog-title')).toHaveText('Ваш круг');
  await close();await page.evaluate(()=>window.storageTest.deferNext=true);await open(false);await page.waitForFunction(()=>typeof window.storageTest.release==='function');await page.evaluate(async()=>{const {state}=await import('/js/core.js');state.user={...state.user,id:'00000000-0000-4000-8000-000000000002',owner:false};window.storageTest.release();});await page.waitForTimeout(100);await expect(page.locator('.storage-file')).toHaveCount(0);
  await page.goto(base+'?guest=1');await expect(page.locator('#chat')).toBeVisible();await page.locator('#more-button').tap();await expect(page.getByRole('button',{name:'Хранилище и лимиты',exact:true})).toHaveCount(0);assert.equal(await page.evaluate(async()=>{try{await window.MayakCloud.api('storage',{method:'POST',body:JSON.stringify({action:'overview'})});return 0;}catch(error){return error.status;}}),403);

  const desktop=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'}),wide=await desktop.newPage();wide.on('pageerror',error=>errors.push(error.message));wide.on('request',request=>{if(/\/storage\/v1\//.test(request.url()))contentRequests.push(request.url());});await wide.route('**/cloud.js',route=>route.fulfill({contentType:'text/javascript',body:mock}));await wide.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));await wide.goto(base);await expect(wide.locator('#chat')).toBeVisible();await wide.evaluate(()=>{window.MayakTheme.setSkin('classic');window.MayakTheme.set('light');});await wide.locator('#more-button').click();await wide.getByRole('button',{name:'Хранилище и лимиты',exact:true}).click();await expect(wide.locator('.storage-file')).toHaveCount(50);assert.equal(await wide.locator('#dialog-content').evaluate(node=>node.scrollWidth>node.clientWidth),false);
  await wide.locator('#dialog-close').focus();await wide.keyboard.press('Tab');await expect(wide.getByRole('link',{name:'Открыть точный расход в Supabase'})).toBeFocused();await wide.keyboard.press('Shift+Tab');await expect(wide.locator('#dialog-close')).toBeFocused();
  await wide.screenshot({path:path.join(root,'test-results/storage-desktop-light.png')});await wide.keyboard.press('Escape');await expect(wide.locator('#dialog-layer')).toBeHidden();
  assert.deepEqual(contentRequests,[]);assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});

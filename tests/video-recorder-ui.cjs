// Настоящие camera streams/MediaRecorder Chrome; две facingMode моделируются поверх тестовой камеры.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),http=require('http'),path=require('path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..');
const mock=`(()=>{window.MAYAK_CONFIG={...window.MAYAK_CONFIG,videoEnabled:true};const user={id:'00000000-0000-4000-8000-000000000001',name:'Тестовый участник',owner:false,last_seen:new Date().toISOString()};window.MayakCloud={async api(route){if(route==='session')return {user,room:'Тестовый круг'};if(route.startsWith('events'))return {people:[user],messages:[],reads:[]};return {};},watch(){},stop(){}};})();`;
const cameraSetup=()=>{
 localStorage.setItem('mayak.push.off','1');
 const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),probe=window.cameraProbe={requests:[],streams:[],failTarget:null,deny:false,hold:false};
 navigator.mediaDevices.getUserMedia=async constraints=>{
  const mode=constraints.video.facingMode,target=typeof mode==='string'?mode:mode.exact||mode.ideal;
  probe.requests.push({target,exact:!!mode.exact,liveBefore:probe.streams.flatMap(s=>s.getTracks()).filter(t=>t.readyState==='live').length});
  if(probe.deny)throw new DOMException('Denied','NotAllowedError');
  if(probe.failTarget===target){probe.failTarget=null;throw new DOMException('Unavailable','OverconstrainedError');}
  const stream=await native({...constraints,video:{width:{ideal:target==='user'?480:960},height:{ideal:target==='user'?640:540},frameRate:{ideal:24}}});probe.streams.push(stream);
  const track=stream.getVideoTracks()[0],settings=track.getSettings.bind(track);track.getSettings=()=>({...settings(),facingMode:target});
  if(probe.hold){probe.hold=false;await new Promise(resolve=>probe.release=resolve);}
  return stream;
 };
};
async function geometry(page){return page.evaluate(()=>{const r=selector=>{const b=document.querySelector(selector).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};return {panel:r('.video-record-panel'),screen:r('.video-record-screen'),scale:visualViewport.scale};});}
function unchanged(a,b){for(const part of ['panel','screen'])for(const key of ['x','y','width','height'])assert.ok(Math.abs(a[part][key]-b[part][key])<1,JSON.stringify({a,b}));assert.equal(b.scale,1);}
test('recorder: stable taps/states, themed wallpaper, camera flip/fallback and pending cancellation',{timeout:70000},async()=>{
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{const file=path.resolve(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html');if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]});fs.createReadStream(file).pipe(res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));await page.route('**/cloud.js',r=>r.fulfill({contentType:'text/javascript',body:mock}));await page.addInitScript(cameraSetup);await page.goto('http://127.0.0.1:'+server.address().port+'/');await expect(page.locator('#chat')).toBeVisible();
  const start=page.getByRole('button',{name:'Начать запись',exact:true}),flip=page.getByRole('button',{name:'Переключить камеру',exact:true}),cancel=page.getByRole('button',{name:'Отмена',exact:true}),layer=page.locator('.video-record-layer');
  await page.locator('#camera-button').tap();const initial=await geometry(page);await expect(start).toBeEnabled();await page.waitForTimeout(650);unchanged(initial,await geometry(page));
  assert.equal(initial.screen.width,initial.screen.height);assert.ok(initial.screen.width>200);
  const cdp=await context.newCDPSession(page),p={x:initial.panel.x+20,y:initial.panel.y+85};
  for(let i=0;i<8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(50);unchanged(initial,await geometry(page));}
  await page.locator('.video-record-preview').dispatchEvent('dblclick');unchanged(initial,await geometry(page));
  await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:visualViewport.height-70});visualViewport.dispatchEvent(new Event('resize'));});unchanged(initial,await geometry(page));await page.evaluate(()=>delete visualViewport.height);
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});await page.screenshot({path:path.join(root,'test-results/recorder-light.png')});
  await page.evaluate(()=>window.MayakTheme.set('dark'));assert.match(await page.locator('.video-record-panel').evaluate(n=>getComputedStyle(n,'::before').filter),/invert/);await page.screenshot({path:path.join(root,'test-results/recorder-dark.png')});
  await flip.tap();await expect(start).toBeEnabled();await expect(page.locator('.video-record-status')).toContainText('основная');await expect(page.locator('.video-record-preview')).not.toHaveClass(/live/);unchanged(initial,await geometry(page));
  assert.equal(await page.evaluate(()=>window.cameraProbe.requests.at(-1).target),'environment');assert.equal(await page.evaluate(()=>window.cameraProbe.requests.at(-1).liveBefore),0);
  await page.evaluate(()=>window.cameraProbe.failTarget='user');await flip.tap();await expect(start).toBeEnabled();await expect(page.locator('.video-record-status')).toContainText('Камера не переключилась');assert.equal(await page.evaluate(()=>window.cameraProbe.requests.at(-1).target),'environment');unchanged(initial,await geometry(page));
  await flip.tap();await expect(start).toBeEnabled();await expect(page.locator('.video-record-preview')).toHaveClass(/live/);unchanged(initial,await geometry(page));
  await start.tap();await expect(flip).toBeDisabled();await page.waitForTimeout(1400);unchanged(initial,await geometry(page));await page.getByRole('button',{name:'Остановить',exact:true}).tap();await expect(page.getByRole('button',{name:'Отправить',exact:true})).toBeVisible();unchanged(initial,await geometry(page));
  assert.equal(await page.evaluate(()=>window.cameraProbe.streams.flatMap(s=>s.getTracks()).every(t=>t.readyState==='ended')),true);
  await page.getByRole('button',{name:'Посмотреть',exact:true}).tap();await page.waitForTimeout(150);unchanged(initial,await geometry(page));await page.screenshot({path:path.join(root,'test-results/recorder-preview.png')});await cancel.tap();await expect(layer).toHaveCount(0);
  // Недоступная вторая камера не лишает возможности записать с первой.
  await page.locator('#camera-button').tap();await expect(start).toBeEnabled();await page.evaluate(()=>window.cameraProbe.failTarget='environment');await flip.tap();await expect(start).toBeEnabled();await expect(page.locator('.video-record-status')).toContainText('Фронтальная');await cancel.tap();
  for(const size of [{width:320,height:568},{width:740,height:320}]){await page.setViewportSize(size);await page.locator('#camera-button').click();await expect(start).toBeEnabled();const b=await geometry(page);assert.ok(b.panel.x>=0&&b.panel.y>=0&&b.panel.x+b.panel.width<=size.width&&b.panel.y+b.panel.height<=size.height);assert.ok(b.screen.width>=100);assert.equal(b.screen.width,b.screen.height);await page.screenshot({path:path.join(root,'test-results/recorder-'+size.width+'.png')});await cancel.click();}
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.cameraProbe.hold=true);await page.locator('#camera-button').tap();await page.waitForFunction(()=>!!window.cameraProbe.release);await cancel.tap();await page.evaluate(()=>{window.cameraProbe.release();window.cameraProbe.release=null;});await page.waitForTimeout(200);await expect(layer).toHaveCount(0);assert.equal(await page.evaluate(()=>window.cameraProbe.streams.flatMap(s=>s.getTracks()).every(t=>t.readyState==='ended')),true);
  await page.evaluate(()=>window.cameraProbe.deny=true);await page.locator('#camera-button').tap();await expect(page.locator('.video-record-status')).toContainText('Разрешите доступ');await expect(flip).toBeDisabled();await page.keyboard.press('Escape');await expect(layer).toHaveCount(0);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

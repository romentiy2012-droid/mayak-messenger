const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..'),UID='00000000-0000-4000-8000-000000000001';
const mock=`(()=>{
const uid='${UID}',user={id:uid,name:'Тестовый участник',owner:true,last_read:0},now=new Date().toISOString();
window.weatherTest={time:Date.parse('2026-11-27T08:00:00Z'),empty:false,offline:false,invalid:false,stale:false,long:false,calls:[],read:0};
window.MayakCloud={async api(path,options={}){const t=window.weatherTest;t.calls.push(path);
 if(path==='session')return {user,room:'Наш круг'};
 if(path.startsWith('events'))return {people:[{...user,last_seen:now}],messages:Array.from({length:20},(_,i)=>({id:i+1,rev:i+1,user_id:uid,name:user.name,text:'Тестовая строка '+i,kind:'text',created:now,reactions:{},peer_a:null,peer_b:null})),reads:[],direct_full:true};
 if(path==='read'){t.read++;return {};}
 if(path.startsWith('weather')){if(t.offline)throw Error('Network unavailable');let a=t.time;
  const history=Array.from({length:180},(_,i)=>({time:new Date(a-(180-i)*60000).toISOString(),temperature:28+Math.sin(i/20),humidity:35+Math.cos(i/30)}));
  return {server_time:new Date(a).toISOString(),station:{id:'astrakhan-lit',city:'Астрахань',location:'5-я Литейная'},latest:t.empty?null:{received_at:new Date(a-(t.stale?900000:0)).toISOString(),measured_at:new Date(a-(t.stale?900000:0)).toISOString(),sensor_valid:!t.invalid,temperature:t.long?-40:28.1,humidity:t.long?100:35,firmware:'1.5.0',weather:{temperature:1.8,humidity:62,feels_like:-3,wind:4,code:2,observed_at:a/1000-300,sunrise:[Date.parse('2026-11-27T04:00:00Z')/1000,Date.parse('2026-11-28T04:01:00Z')/1000],sunset:[Date.parse('2026-11-27T13:00:00Z')/1000,Date.parse('2026-11-28T12:59:00Z')/1000]}},history:t.empty?[]:history};
 }return {};
},watch(){},stop(){}};
})();`;
async function fixture(){
 const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{const n=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html',p=path.resolve(root,n);if(!p.startsWith(root+path.sep)||!types[path.extname(p)]||!fs.existsSync(p)){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':types[path.extname(p)],'Cache-Control':'no-store'});res.end(n==='cloud.js'?mock:fs.readFileSync(p));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Tokyo',serviceWorkers:'block'});
 await context.addInitScript(()=>localStorage.setItem('mayak.push.off','1'));await context.route('https://**',route=>route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await expect(page.locator('#chat')).toBeVisible();
 return {page,context,errors,close:async()=>{await browser.close();await new Promise(r=>server.close(r));}};
}
test('weather UI: header thermometer, daytime/night, all windows, draft/read isolation and back',async()=>{
 const f=await fixture();try{const {page}=f;await page.locator('#message-input').fill('Сохранить мой черновик');await page.waitForTimeout(700);
 const before=await page.locator('#messages-scroll').evaluate(e=>e.scrollTop),read=await page.evaluate(()=>weatherTest.read);
 assert.equal(await page.locator('#weather-button').evaluate(e=>e.nextElementSibling.id),'invite-button');
 await page.getByRole('button',{name:'Метеостанция',exact:true}).tap();await expect(page.locator('#meteo-status')).toHaveText('Станция на связи');await expect(page.locator('#meteo-screen')).toHaveAttribute('data-theme','light');await expect(page.locator('#meteo-clock')).toHaveText(/^12:00:\d{2}$/);assert.equal(await page.locator('.meteo-card').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');await expect(page.locator('#meteo-temp')).toHaveText('+28,1');
 await expect(page.locator('#meteo-windows button[aria-pressed=true]')).toHaveText('1 ч');assert.ok(await page.evaluate(()=>weatherTest.calls.includes('weather?minutes=60')));
 await expect(page.locator('.meteo-eyebrow')).toHaveText('ВАША МЕТЕОСТАНЦИЯ');assert.match(await page.locator('#meteo-screen').evaluate(e=>getComputedStyle(e,'::before').backgroundImage),/chat-nautical\.png/);
 assert.equal(await page.locator('#chat').evaluate(e=>e.inert),true);await page.evaluate(async()=>{(await import('/js/messages.js')).markRead();});await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>weatherTest.read),read);
 for(const [i,s]of ['30 мин','1 ч','3 ч','6 ч','12 ч','24 ч'].entries()){await page.locator('#meteo-windows').getByRole('button',{name:s,exact:true}).tap();await expect(page.locator('#meteo-windows button').nth(i)).toHaveAttribute('aria-pressed','true');await expect(page.locator('#meteo-refresh')).toBeEnabled();}
 await page.screenshot({path:path.join(root,'test-results/weather-phone-day.png')});
 await page.evaluate(()=>weatherTest.time=Date.parse('2026-11-27T18:00:00Z'));await page.locator('#meteo-refresh').tap();await expect(page.locator('#meteo-screen')).toHaveAttribute('data-theme','dark');await expect(page.locator('#meteo-clock')).toHaveText(/^22:00:\d{2}$/);assert.match(await page.locator('#meteo-screen').evaluate(e=>getComputedStyle(e,'::before').filter),/invert\(1\)/);await page.waitForTimeout(400);await page.screenshot({path:path.join(root,'test-results/weather-phone-night.png')});
 await page.locator('#meteo-back').tap();await expect(page.locator('#meteo-screen')).toBeHidden();await expect(page.locator('#message-input')).toHaveValue('Сохранить мой черновик');assert.equal(await page.locator('#messages-scroll').evaluate(e=>e.scrollTop),before);
 await page.locator('#weather-button').tap();await expect(page.locator('#meteo-windows button[aria-pressed=true]')).toHaveText('1 ч');await page.goBack();await expect(page.locator('#meteo-screen')).toBeHidden();
 assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('weather UI: small and desktop screens, honest empty/offline/sensor failure, account exit',async()=>{
 const f=await fixture();try{const {page}=f;await page.locator('#weather-button').tap();await expect(page.locator('#meteo-status')).toHaveText('Станция на связи');
 for(const size of [{width:320,height:568},{width:390,height:844},{width:1024,height:950}]){
  await page.setViewportSize(size);await page.evaluate(()=>weatherTest.long=true);await page.locator('#meteo-refresh').tap();await expect(page.locator('#meteo-rh')).toHaveText('100,0');
  assert.ok(await page.locator('.chat-header').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  assert.ok(await page.locator('#meteo-screen').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  assert.ok(await page.locator('#meteo-temp').evaluate(e=>e.getBoundingClientRect().right<document.querySelector('#meteo-rh').getBoundingClientRect().left));
  assert.ok(await page.locator('#meteo-clock').evaluate(e=>e.getBoundingClientRect().left>=document.querySelector('.meteo-heading>div').getBoundingClientRect().right));
  await page.screenshot({path:path.join(root,'test-results/weather-'+size.width+'.png')});
 }
 await page.evaluate(()=>{weatherTest.stale=true;weatherTest.long=false;});await page.locator('#meteo-refresh').click();await expect(page.locator('#meteo-status')).toHaveText('Станция не на связи');await expect(page.locator('#meteo-alert')).toContainText('последние полученные');
 await page.evaluate(()=>{weatherTest.stale=false;weatherTest.invalid=true;});await page.locator('#meteo-refresh').click();await expect(page.locator('#meteo-temp')).toHaveText('—');await expect(page.locator('#meteo-status')).toHaveText('Ошибка датчика');
 await page.evaluate(()=>weatherTest.empty=true);await page.locator('#meteo-refresh').click();await expect(page.locator('.meteo-chart-empty')).toContainText('после подключения');await expect(page.locator('#meteo-status')).toHaveText('Станция ещё не подключена');
 await page.evaluate(()=>weatherTest.offline=true);await page.locator('#meteo-refresh').click();await expect(page.locator('#meteo-alert')).toContainText('Не удалось обновить');
 await page.evaluate(async()=>{(await import('/js/session.js')).showJoin(true);});await expect(page.locator('#meteo-screen')).toBeHidden();await expect(page.locator('#chat')).toBeHidden();assert.equal(await page.locator('#chat').evaluate(e=>e.inert),false);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('weather clock: seconds run locally, blinking stops for stale station and reduced motion',{timeout:30000},async()=>{
 const f=await fixture();try{const {page}=f;
  await page.clock.install({time:new Date('2026-11-27T08:00:00Z')});await page.clock.pauseAt(new Date('2026-11-27T08:01:00Z'));await page.locator('#weather-button').tap();await expect(page.locator('#meteo-status')).toHaveText('Станция на связи');await expect(page.locator('#meteo-clock')).toHaveText('12:00:00');
  const calls=await page.evaluate(()=>weatherTest.calls.filter(p=>p.startsWith('weather')).length);
  await page.clock.runFor(3100);await expect(page.locator('#meteo-clock')).toHaveText('12:00:03');assert.equal(await page.evaluate(()=>weatherTest.calls.filter(p=>p.startsWith('weather')).length),calls);
  const blink=await page.locator('.meteo-clock-separator').first().evaluate(e=>{const a=e.getAnimations()[0];a.pause();a.currentTime=0;const on=getComputedStyle(e).opacity;a.currentTime=750;return {on,off:getComputedStyle(e).opacity};});assert.equal(blink.on,'1');assert.equal(blink.off,'0');
  assert.equal(await page.locator('#meteo-status').evaluate(e=>getComputedStyle(e,'::before').animationName),'meteo-online-blink');
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.meteo-clock-separator').first().evaluate(e=>getComputedStyle(e).animationName),'none');assert.equal(await page.locator('#meteo-status').evaluate(e=>getComputedStyle(e,'::before').animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>weatherTest.stale=true);await page.locator('#meteo-refresh').tap();await expect(page.locator('#meteo-status')).toHaveText('Станция не на связи');assert.equal(await page.locator('#meteo-status').evaluate(e=>getComputedStyle(e,'::before').animationName),'none');
  await page.locator('#meteo-back').tap();const closed=await page.locator('#meteo-clock').textContent();await page.clock.runFor(3000);assert.equal(await page.locator('#meteo-clock').textContent(),closed);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

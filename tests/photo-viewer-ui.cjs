// Реальные multi-touch события Chrome; только синтетическая фотография и облако.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..');
const mock=`(()=>{const user={id:'00000000-0000-4000-8000-000000000001',name:'Тестовый участник',owner:true,last_read:0},now=new Date().toISOString();
window.MayakCloud={async api(p){if(p==='session')return {user,room:'Тестовый круг'};if(p.startsWith('events'))return {people:[user],messages:[{id:1,rev:1,user_id:user.id,name:user.name,text:'Синтетическая фотография',kind:'photo',file:'synthetic/photo.png',file_meta:{w:1200,h:1800},created:now,reactions:{},peer_a:null,peer_b:null}],reads:[],direct_full:true};return {};},watch(){},stop(){},async download(){const c=document.createElement('canvas');c.width=1200;c.height=1800;const x=c.getContext('2d');x.fillStyle='#164d60';x.fillRect(0,0,c.width,c.height);for(let y=0;y<1800;y+=150)for(let i=0;i<1200;i+=150){x.fillStyle=(i/150+y/150)%2?'#efc67c':'#75b3a5';x.fillRect(i+4,y+4,142,142);}x.fillStyle='#142c36';x.fillRect(260,700,680,200);x.fillStyle='white';x.font='70px sans-serif';x.fillText('Тестовое фото',300,830);return new Promise(r=>c.toBlob(r,'image/png'));}};})();`;
async function fixture(size={width:390,height:844}){
 const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{const p=path.resolve(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html');if(!p.startsWith(root+path.sep)||!types[path.extname(p)]||!fs.existsSync(p)){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':types[path.extname(p)],'Cache-Control':'no-store'});res.end(path.basename(p)==='cloud.js'?mock:fs.readFileSync(p));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:size,isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[];
 await context.addInitScript(()=>{localStorage.setItem('mayak.push.off','1');localStorage.setItem('mayak.skin','classic');});await context.route('https://**',r=>r.abort());page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await expect(page.locator('#chat')).toBeVisible();await page.waitForFunction(()=>document.querySelector('[data-photo] img')?.naturalWidth>0);
 return {page,context,errors,close:async()=>{await browser.close();await new Promise(r=>server.close(r));}};
}
async function transform(page){return page.locator('#viewer-image').evaluate(e=>{const m=new DOMMatrixReadOnly(getComputedStyle(e).transform);return {scale:m.a,x:m.e,y:m.f};});}
async function touches(cdp,type,points){await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map((p,i)=>({...p,id:i+1,radiusX:3,radiusY:3,force:1}))});}
test('photo pinch zoom affects only the image, keeps close fixed and permits panning',{timeout:45000},async()=>{
 const f=await fixture();try{const {page}=f;await page.locator('#message-input').fill('Черновик до просмотра');await page.locator('[data-photo]').tap();await expect(page.locator('#viewer-layer')).toBeVisible();await page.waitForFunction(()=>document.querySelector('#viewer-image').naturalWidth>0);
 const close=await page.locator('#viewer-close').boundingBox(),cdp=await f.context.newCDPSession(page),center={x:195,y:422};
 await touches(cdp,'touchStart',[{x:center.x-50,y:center.y},{x:center.x+50,y:center.y}]);for(let i=1;i<=8;i++)await touches(cdp,'touchMove',[{x:center.x-50-i*10,y:center.y},{x:center.x+50+i*10,y:center.y}]);await touches(cdp,'touchEnd',[]);
 const zoom=await transform(page);assert.ok(zoom.scale>2,'Photo itself must zoom: '+JSON.stringify(zoom));assert.equal(await page.evaluate(()=>visualViewport.scale),1);await expect(page.locator('#viewer-layer')).toBeVisible();assert.deepEqual(await page.locator('#viewer-close').boundingBox(),close);
 await touches(cdp,'touchStart',[center]);for(let i=1;i<=6;i++)await touches(cdp,'touchMove',[{x:center.x+i*10,y:center.y+40}]);await touches(cdp,'touchEnd',[]);const pan=await transform(page);assert.ok(pan.x>zoom.x+30);assert.equal(pan.scale,zoom.scale);
 await page.screenshot({path:path.join(root,'test-results/photo-pinch-zoom.png')});await page.locator('#viewer-close').tap();await expect(page.locator('#viewer-layer')).toBeHidden();await expect(page.locator('#message-input')).toHaveValue('Черновик до просмотра');assert.equal(await page.evaluate(()=>visualViewport.scale),1);
 await page.locator('[data-photo]').tap();assert.equal((await transform(page)).scale,1);await page.keyboard.press('Escape');await expect(page.locator('#viewer-layer')).toBeHidden();assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('photo viewer contains zoom on small/landscape screens and resets on resize',{timeout:45000},async()=>{
 const f=await fixture({width:320,height:568});try{const {page}=f;await page.locator('[data-photo]').tap();await expect(page.locator('#viewer-layer')).toBeVisible();await page.waitForFunction(()=>document.querySelector('#viewer-image').naturalWidth>0);
 await page.locator('#viewer-image').tap();await expect(page.locator('#viewer-layer')).toBeVisible();
 await page.mouse.move(160,284);await page.mouse.wheel(0,-600);await expect.poll(async()=>(await transform(page)).scale).toBeGreaterThan(1.5);
 await page.setViewportSize({width:740,height:320});await expect.poll(async()=>(await transform(page)).scale).toBe(1);await expect(page.locator('#viewer-close')).toBeInViewport();assert.equal(await page.evaluate(()=>visualViewport.scale),1);
 await page.locator('#viewer-close').tap();assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

// Настоящие cloud.js и Supabase Auth; все аккаунты, токены и HTTP-ответы синтетические.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium,expect}=require('@playwright/test'),root=path.resolve(__dirname,'..');
const HOST='session-fixture.supabase.co',KEY='mayak.cloud.auth:'+HOST,UID='00000000-0000-4000-8000-000000000001';
const user={id:UID,aud:'authenticated',role:'authenticated',email:'synthetic@example.invalid',app_metadata:{provider:'email',providers:['email']},user_metadata:{},created_at:'2026-01-01T00:00:00Z'};
const member={id:UID,name:'Тестовый участник',owner:false,last_read:0,last_seen:new Date().toISOString()};
function session(expired=false){const exp=Math.floor(Date.now()/1000)+(expired?-30:3600);const b=value=>Buffer.from(JSON.stringify(value)).toString('base64url');return {access_token:b({alg:'HS256',typ:'JWT'})+'.'+b({sub:UID,aud:'authenticated',role:'authenticated',exp,iat:exp-3600})+'.synthetic',refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:3600,expires_at:exp,user};}
async function fixture({saved=session(),hold=false,fail=false,hash=''}={}){
 const probe={password:0,refresh:0,logout:0,profile:0,hold,fail,releases:[],errors:[]};
 const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{
  const file=path.resolve(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html');
  if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404).end();return;}
  let source=fs.readFileSync(file);
  if(file===path.join(root,'config.js'))source=Buffer.from(`window.MAYAK_CONFIG={supabaseURL:'https://${HOST}',supabasePublishableKey:'sb_publishable_synthetic'};`);
  // Realtime transport не относится к входу; auth/session/network остаются настоящими.
  if(file===path.join(root,'cloud.js'))source=Buffer.concat([source,Buffer.from('\nwindow.MayakCloud.watch=()=>{};')]);
  res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'}).end(source);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser,context;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const setup=async(storageState)=>{
   context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block',storageState});
   await context.route('https://'+HOST+'/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/auth/v1/token'){
     const grant=url.searchParams.get('grant_type');if(grant==='password')probe.password++;else if(grant==='refresh_token')probe.refresh++;else throw Error('Unexpected grant '+grant);
     return json(session());
    }
    if(url.pathname==='/auth/v1/logout'){probe.logout++;return json({});}
    if(url.pathname==='/auth/v1/health')return json({ok:true});
    if(url.pathname==='/rest/v1/mayak_members'){
     if(url.searchParams.has('id')){
      probe.profile++;
      if(probe.hold)await new Promise(resolve=>probe.releases.push(resolve));
      if(probe.fail)return json({message:'Synthetic upstream unavailable'},503);
     }
     return json([member]);
    }
    if(url.pathname==='/rest/v1/rpc/mayak_profile')return json(member);
    if(url.pathname.startsWith('/rest/v1/'))return json([]);
    throw Error('Unexpected synthetic endpoint '+url.pathname);
   });
   await context.addInitScript(({saved,key})=>{
    localStorage.setItem('mayak.push.off','1');localStorage.setItem('mayak.skin','classic');
    if(!localStorage.getItem('fixture.seeded')){if(saved)localStorage.setItem(key,JSON.stringify(saved));localStorage.setItem('fixture.seeded','1');}
    window.credentialsShown=false;
    new MutationObserver(()=>{const p=document.getElementById('join-password');if(p&&!p.matches(':disabled')&&p.getClientRects().length)window.credentialsShown=true;}).observe(document,{subtree:true,childList:true,attributes:true});
   },{saved,key:KEY});
   const page=await context.newPage();page.on('pageerror',e=>probe.errors.push(e.message));return page;
  };
  const url='http://127.0.0.1:'+server.address().port+'/',page=await setup();
  await page.goto(url+hash,{waitUntil:'domcontentloaded'});
  return {page,probe,url,release(){probe.hold=false;probe.releases.splice(0).forEach(fn=>fn());},async reopen(){const stored=await context.storageState();await context.close();const page=await setup(stored);await page.goto(url,{waitUntil:'domcontentloaded'});return page;},async close(){probe.releases.splice(0).forEach(fn=>fn());await browser.close();await new Promise(resolve=>server.close(resolve));}};
 }catch(error){await browser?.close();await new Promise(resolve=>server.close(resolve));throw error;}
}
async function noForm(page){await expect(page.locator('#welcome')).toBeHidden();await expect(page.locator('#join-password')).toBeDisabled();assert.equal(await page.evaluate(()=>window.credentialsShown),false);}

test('cold launch and reopened page restore stored auth without ever exposing credentials',{timeout:45000},async()=>{
 const f=await fixture({hold:true});let {page}=f;
 try{
  await expect.poll(()=>f.probe.profile).toBe(1);await expect(page.locator('#startup')).toBeVisible();await noForm(page);
  await page.evaluate(async()=>{const {boot}=await import('/js/session.js');boot();boot();window.dispatchEvent(new Event('online'));});
  await page.waitForTimeout(200);assert.equal(f.probe.profile,1);
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});await page.screenshot({path:path.join(root,'test-results/session-startup-light.png')});
  await page.evaluate(()=>window.MayakTheme.set('dark'));await page.screenshot({path:path.join(root,'test-results/session-startup-dark.png')});
  f.release();await expect(page.locator('#chat')).toBeVisible();await noForm(page);assert.equal(f.probe.password,0);assert.equal(f.probe.refresh,0);
  page=await f.reopen();await expect(page.locator('#chat')).toBeVisible();await noForm(page);
  await page.reload();await expect(page.locator('#chat')).toBeVisible();await noForm(page);assert.equal(f.probe.password,0);assert.equal(f.probe.logout,0);assert.deepEqual(f.probe.errors,[]);
 }finally{await f.close();}
});

test('expired access token refreshes once without password sign-in or login screen',{timeout:45000},async()=>{
 const f=await fixture({saved:session(true)});const {page}=f;
 try{await expect(page.locator('#chat')).toBeVisible();await noForm(page);assert.equal(f.probe.refresh,1);assert.equal(f.probe.password,0);
  const stored=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),KEY);assert.ok(stored.expires_at>Date.now()/1000);
  await page.reload();await expect(page.locator('#chat')).toBeVisible();await noForm(page);assert.equal(f.probe.refresh,1);assert.deepEqual(f.probe.errors,[]);
 }finally{await f.close();}
});

test('server failure, offline retry and reconnect keep the session and never show login',{timeout:45000},async()=>{
 const saved=session(),f=await fixture({saved,fail:true}),{page}=f;
 try{
  await expect(page.locator('#startup-retry')).toBeVisible({timeout:20000});await noForm(page);
  assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).access_token,KEY),saved.access_token);
  await page.screenshot({path:path.join(root,'test-results/session-connection-retry.png')});
  await page.context().setOffline(true);await page.locator('#startup-retry').tap();await expect(page.locator('#startup-retry')).toBeVisible({timeout:20000});await noForm(page);
  f.probe.fail=false;await page.context().setOffline(false);await expect(page.locator('#chat')).toBeVisible();await noForm(page);assert.equal(f.probe.password,0);assert.equal(f.probe.logout,0);assert.deepEqual(f.probe.errors,[]);
 }finally{await f.close();}
});

test('connection retry succeeds on button and on returning to the app',{timeout:45000},async()=>{
 const f=await fixture({fail:true}),{page}=f;
 try{
  await expect(page.locator('#startup-retry')).toBeVisible({timeout:20000});f.probe.fail=false;await page.locator('#startup-retry').tap();await expect(page.locator('#chat')).toBeVisible();await noForm(page);
  f.probe.fail=true;await page.reload();await expect(page.locator('#startup-retry')).toBeVisible({timeout:20000});f.probe.fail=false;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.locator('#chat')).toBeVisible();await noForm(page);assert.equal(f.probe.password,0);assert.deepEqual(f.probe.errors,[]);
 }finally{await f.close();}
});

test('missing session permits deliberate login and explicit logout',{timeout:45000},async()=>{
 const f=await fixture({saved:null}),{page}=f;
 try{
  await expect(page.locator('#welcome')).toBeVisible();await expect(page.locator('#startup')).toBeHidden();await expect(page.locator('#join-password')).toBeEnabled();assert.equal(f.probe.password,0);
  await page.locator('#join-name').fill('Синтетический участник');await page.locator('#join-password').fill('synthetic-password');await page.locator('#join-button').tap();
  await expect(page.locator('#chat')).toBeVisible();assert.equal(f.probe.password,1);await expect(page.locator('#join-password')).toBeDisabled();
  await page.locator('#more-button').tap();await page.getByRole('button',{name:'Выйти на этом устройстве',exact:true}).tap();
  await expect(page.locator('#welcome')).toBeVisible();assert.equal(f.probe.logout,1);assert.equal(await page.evaluate(key=>localStorage.getItem(key),KEY),null);
  await page.reload();await expect(page.locator('#welcome')).toBeVisible();assert.equal(f.probe.password,1);assert.deepEqual(f.probe.errors,[]);
 }finally{await f.close();}
});

test('password reset overrides a pending restore; stale response cannot reopen the chat',{timeout:45000},async()=>{
 const f=await fixture({hold:true}),{page}=f;
 try{
  await expect.poll(()=>f.probe.profile).toBe(1);await noForm(page);
  await page.evaluate(()=>location.hash='reset=synthetic-reset-link');await expect(page.locator('#welcome')).toBeVisible();await expect(page.locator('#join-identity')).toBeHidden();await expect(page.locator('#join-password')).toHaveAttribute('autocomplete','new-password');
  await page.locator('#reset-cancel').tap();await expect.poll(()=>f.probe.profile).toBe(2);await expect(page.locator('#startup')).toBeVisible();
  f.release();await expect(page.locator('#chat')).toBeVisible();assert.equal(f.probe.password,0);assert.deepEqual(f.probe.errors,[]);
 }finally{await f.close();}
});

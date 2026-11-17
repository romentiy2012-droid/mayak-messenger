// Настоящая запись тестовой камерой Chrome и настоящая конвертация FFmpeg; рабочее облако не используется.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium,expect}=require('@playwright/test');
const root=path.resolve(__dirname,'..');
const mock=`(() => {
 window.MAYAK_CONFIG={...window.MAYAK_CONFIG,videoEnabled:true};
 const id='00000000-0000-4000-8000-000000000001',user={id,name:'Кэп',owner:true,last_read:0,online:true,last_seen:new Date().toISOString()},peer={id:'00000000-0000-4000-8000-000000000002',name:'Екатерина',last_read:0,last_seen:new Date().toISOString()};
 let messages=[],callback=null,job=null,bytes=null;
 window.videoTest={uploads:0,starts:0,failNext:false,conversions:0,startBodies:[]};
 window.MayakCloud={
  async api(path,options={}){
   const route=path.split('?')[0],body=JSON.parse(options.body||'{}');
   if(route==='session')return {user,room:'Наш круг'};
   if(route==='events')return {people:[user,peer],messages,reads:[]};
   if(route==='video-start'){
    window.videoTest.starts++;window.videoTest.startBodies.push(body);
    if(!job||job.nonce!==body.nonce){job={id:'job-id',nonce:body.nonce,state:'processing'};window.videoTest.conversions++;
     window.convertInput(bytes).then(meta=>{const message={id:messages.length+1,rev:messages.length+1,user_id:id,name:user.name,text:'📹 Видеокружочек',nonce:body.nonce,kind:'video',file:'output-'+body.nonce+'.mp4',file_meta:meta,created:new Date().toISOString(),reactions:{},...(body.peer?{peer_a:id,peer_b:body.peer}:{})};messages=[...messages,message];job={...job,state:'sent',message_id:message.id};callback?.('message',message);}).catch(error=>job={...job,state:'failed',error:error.message});}
    if(window.videoTest.failNext){window.videoTest.failNext=false;throw Object.assign(Error('Ответ потерялся. Повторите отправку.'),{status:503});}
    return {job};
   }
   if(route==='video-status')return {job,message:messages.find(message=>message.id===job.message_id)};
   if(route==='video-cancel'){job={...job,state:'cancelled'};return {job};}
   if(route==='delete'){messages=messages.map(m=>({...m,deleted:new Date().toISOString(),file:null}));return {message:messages[0]};}
   return {};
  },
  watch(fn){callback=fn;},stop(){callback=null;},
  async videoUpload(blob){window.videoTest.uploads++;bytes=Array.from(new Uint8Array(await blob.arrayBuffer()));return id+'/'+'a'.repeat(24)+'.mp4';},
  async videoDownload(){return (await fetch('/__output.mp4')).blob();},async videoRemove(){},async videoSourceRemove(){}
 };
})();`;
test('video UI: cancel, real camera preview, retry without duplicate, conversion and circular playback', {timeout:90000},async()=>{
 const {convertVideo}=await import('../video-worker/lib/convert.js');let output=null;
 // Use known continuous microphone samples rather than the platform-default fake source.
 const microphone=path.join(root,'test-results/video-test-microphone.wav');fs.mkdirSync(path.dirname(microphone),{recursive:true});
 require('node:child_process').execFileSync(require('../video-worker/node_modules/@ffmpeg-installer/ffmpeg').path,['-y','-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=660:sample_rate=48000','-t','15','-ac','1','-c:a','pcm_s16le',microphone],{windowsHide:true});
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{
  const parsed=new URL(req.url,'http://localhost');
  if(parsed.pathname==='/__output.mp4'&&output){res.writeHead(200,{'Content-Type':'video/mp4'});res.end(output);return;}
  const name=decodeURIComponent(parsed.pathname)==='/'?'index.html':decodeURIComponent(parsed.pathname).slice(1),file=path.resolve(root,name);
  if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]});fs.createReadStream(file).pipe(res);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+microphone]});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/cloud.js',route=>route.fulfill({contentType:'text/javascript',body:mock}));
  await page.addInitScript(()=>{localStorage.setItem('mayak.push.off','1');window.cameraTracks=[];const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);window.cameraTracks.push(...stream.getTracks());return stream;};});
  await page.exposeFunction('convertInput',async bytes=>{fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/video-camera-source.bin'),Buffer.from(bytes));const result=await convertVideo(Buffer.from(bytes));output=result.data;return result.meta;});
  await page.goto('http://127.0.0.1:'+server.address().port+'/');await expect(page.locator('#chat')).toBeVisible();
  await page.locator('#camera-button').click();await expect(page.getByRole('button',{name:'Начать запись',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Отмена',exact:true}).click();assert.equal(await page.evaluate(()=>window.cameraTracks.every(t=>t.readyState==='ended')),true);
  await page.locator('#camera-button').click();
  await expect(page.getByRole('button',{name:'Начать запись',exact:true})).toBeEnabled({timeout:10000}).catch(async error=>{console.error('camera status:',await page.locator('.video-record-status').allTextContents(),'; page errors:',errors);throw error;});
  await page.getByRole('button',{name:'Начать запись',exact:true}).click();
  await page.waitForTimeout(2200);await page.getByRole('button',{name:'Остановить',exact:true}).click();
  await expect(page.getByRole('button',{name:'Отправить',exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>window.cameraTracks.every(t=>t.readyState==='ended')),true);
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
  await page.screenshot({path:path.join(root,'test-results/video-preview-mobile.png')});
  await page.evaluate(()=>window.videoTest.failNext=true);
  await page.getByRole('button',{name:'Отправить',exact:true}).click();await expect(page.locator('#send-error')).toContainText('Ответ потерялся');
  await expect(page.locator('#offline-banner')).toBeHidden();
  await expect(page.locator('#attachment-text')).toContainText('В общий чат');
  const pending=await page.evaluate(async()=>{const {state}=await import('/js/core.js');return {room:state.attachment.room,peer:state.attachment.peer,path:state.attachment.path,nonce:state.attachment.nonce};});
  await page.evaluate(async()=>{const {openRoom}=await import('/js/messages.js');openRoom('00000000-0000-4000-8000-000000000002');});
  assert.equal(await page.evaluate(async()=>(await import('/js/core.js')).state.room),'main');
  await page.evaluate(async()=>{(await import('/js/core.js')).state.room='00000000-0000-4000-8000-000000000002';});
  await page.locator('#send-button').click();await expect(page.locator('#send-error')).toContainText('другого чата');
  assert.equal(await page.evaluate(()=>window.videoTest.starts),1);
  assert.deepEqual(await page.evaluate(async()=>{const {state}=await import('/js/core.js');return {room:state.attachment.room,peer:state.attachment.peer,path:state.attachment.path,nonce:state.attachment.nonce};}),pending);
  await page.evaluate(async()=>{const {openRoom}=await import('/js/messages.js');openRoom('main');});
  await page.locator('#send-button').click();await expect(page.locator('.video-note')).toBeVisible({timeout:25000});
  await expect(page.locator('#attachment-bar')).toBeHidden({timeout:25000});
  const counts=await page.evaluate(()=>({uploads:window.videoTest.uploads,conversions:window.videoTest.conversions}));assert.deepEqual(counts,{uploads:1,conversions:1});
  assert.equal(await page.evaluate(()=>window.videoTest.startBodies.every(body=>body.peer===null)),true);
  await page.locator('.video-note').click();await expect(page.locator('.video-note')).toHaveClass(/playing/);
  await page.waitForFunction(()=>document.querySelector('.video-note video').currentTime>0);
  assert.deepEqual(await page.locator('.video-note video').evaluate(v=>[v.videoWidth,v.videoHeight]),[480,480]);
  await page.locator('.video-note').click();await expect(page.locator('.video-note')).not.toHaveClass(/playing/);
  await page.screenshot({path:path.join(root,'test-results/video-chat-mobile.png')});
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:path.join(root,'test-results/video-chat-desktop.png')});
  await page.evaluate(async()=>{(await import('/js/messages.js')).openRoom('00000000-0000-4000-8000-000000000002');});
  await page.locator('#camera-button').click();await expect(page.getByRole('button',{name:'Начать запись',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Начать запись',exact:true}).click();await page.waitForTimeout(2200);await page.getByRole('button',{name:'Остановить',exact:true}).click();
  await page.getByRole('button',{name:'Отправить',exact:true}).click();await expect(page.locator('#attachment-bar')).toBeHidden({timeout:25000});
  assert.equal(await page.evaluate(()=>window.videoTest.startBodies.at(-1).peer),'00000000-0000-4000-8000-000000000002');
  assert.equal(await page.evaluate(()=>window.videoTest.startBodies.at(-1).room),'00000000-0000-4000-8000-000000000002');
  await expect(page.locator('.video-note')).toHaveCount(1);
  await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');};});
  await page.locator('#camera-button').click();await expect(page.locator('.video-record-status')).toContainText('Разрешите доступ');await page.getByRole('button',{name:'Отмена',exact:true}).click();
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});

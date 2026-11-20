// Настоящий плеер и декодер; только синтетические звуковые файлы и облако.
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const {execFileSync} = require('node:child_process');
const {chromium, expect} = require('@playwright/test');
const root = path.resolve(__dirname, '..');
function wav(duration, ranges) {
  const rate = 8000, bytes = Buffer.alloc(44 + duration * rate * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for(const [from, to, amplitude = .3] of ranges) for(let i = from * rate; i < to * rate; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * 440 * Math.PI * 2) * amplitude * 32767), 44 + i * 2);
  return bytes;
}
const mock = `(() => {
 const now = new Date().toISOString(), user = {id:'00000000-0000-4000-8000-000000000001',name:'Тест',owner:true,last_seen:now};
 const messages = ['tail.wav','pause.wav','wrong.m4a','tail.m4a','fallback.wav','timestamp.m4a'].map((file,i) => ({id:i+1,rev:i+1,kind:'voice',file:'synthetic/'+file,file_meta:{duration:92},user_id:'00000000-0000-4000-8000-000000000002',name:'Собеседник',created:now,reactions:{}}));
 window.voiceTest = {downloads:0,heard:0}; window.voiceAudios = [];
 const NativeAudio = window.Audio; window.Audio = function(...args) {const audio = new NativeAudio(...args);window.voiceAudios.push(audio);return audio;};window.Audio.prototype = NativeAudio.prototype;
 window.MayakCloud = {async api(route) {if(route==='session')return {user,room:'Тест'};if(route.startsWith('events'))return {people:[user],messages,reads:[],direct_full:true};if(route==='heard')window.voiceTest.heard++;return {};},watch(){},stop(){},async download(file){window.voiceTest.downloads++;return (await fetch('/'+file)).blob();}};
})();`;
test('voice playback ends at audio boundary, keeps pauses, replays, falls back and records actual duration', {timeout:60000}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mayak-voice-'));
  const samples = {'tail.wav':wav(92, [[0, 1]]), 'pause.wav':wav(8, [[0, 1], [6, 8]]), 'fallback.wav':wav(2, [[0, 2]])};
  const opus = require('./voice-mp4-fixture.cjs')();samples['timestamp.m4a']=opus.broken;
  // Создаём AAC/MP4 с реальным пустым хвостом и MP4 с завышенным movie duration.
  const ffmpeg = require('../video-worker/node_modules/@ffmpeg-installer/ffmpeg').path;
  fs.writeFileSync(path.join(temporary, 'tail.wav'), samples['tail.wav']);
  for(const name of ['tail', 'wrong']) {
    const target = path.join(temporary, name + '.m4a');
    execFileSync(ffmpeg, ['-y','-nostdin','-hide_banner','-loglevel','error','-i',path.join(temporary,'tail.wav'),'-t',name==='wrong'?'1':'92','-c:a','aac','-b:a','32k','-movflags','+faststart',target], {windowsHide:true});
    const bytes = fs.readFileSync(target);
    if(name === 'wrong') {const at = bytes.indexOf(Buffer.from('mvhd'));assert.ok(at > 0);const scale = bytes.readUInt32BE(at + 16);bytes.writeUInt32BE(scale * 92, at + 20);}
    samples[name + '.m4a'] = bytes;
  }
  const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
  const server = http.createServer((req,res) => {
    const relative = decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1) || 'index.html';
    if(relative.startsWith('synthetic/')) {const name = relative.slice(10);if(samples[name]) {res.writeHead(200,{'Content-Type':name.endsWith('.m4a')?'audio/mp4':'audio/wav'});res.end(samples[name]);return;}}
    const file = path.resolve(root,relative);
    if(!file.startsWith(root+path.sep) || !mime[path.extname(file)] || !fs.existsSync(file)) {res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-store'});res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
    const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}), page = await context.newPage(), errors = [];
    page.on('pageerror',error => errors.push(error.message));
    await page.route('**/cloud.js',route => route.fulfill({contentType:'text/javascript',body:mock}));
    await page.addInitScript(() => localStorage.setItem('mayak.push.off','1'));
    await page.goto('http://127.0.0.1:'+server.address().port);await expect(page.locator('#chat')).toBeVisible();
    const row = id => page.locator('[data-voice="'+id+'"]');
    const active = () => page.evaluate(async () => (await import('/js/media.js')).voicePlaying());
    await expect.poll(() => page.evaluate(() => window.voiceTest.downloads)).toBe(6);
    // Прежний код продолжает играть 90 секунд тишины; новая граница останавливает за ~1,25 с.
    for(const id of [1, 3, 4]) {
      await row(id).locator('.voice-play').tap();await expect.poll(active).toBe(true);
      await expect.poll(active,{timeout:7000}).toBe(false);
      await expect(row(id).locator('.voice-play')).toHaveText('▶');
      await expect(row(id).locator('.voice-time')).toHaveText(/0:0[12]/);
      assert.equal(await row(id).locator('.voice-bar i').evaluate(node => node.style.width),'0%');
    }
    // Пауза, скорость, повтор и отсутствие повторной загрузки.
    await row(1).locator('.voice-speed').tap();await row(1).locator('.voice-play').tap();await expect.poll(active).toBe(true);
    assert.equal(await page.evaluate(() => window.voiceAudios.at(-1).playbackRate),1.5);
    await row(1).locator('.voice-play').tap();await expect.poll(active).toBe(false);
    await row(1).locator('.voice-play').tap();await expect.poll(active,{timeout:5000}).toBe(false);
    await row(2).locator('.voice-play').tap();await expect.poll(active).toBe(true);await page.waitForTimeout(1800);
    assert.equal(await active(),true,'silence inside the message must not stop playback');
    await page.evaluate(async () => {window.voiceAudios.at(-1).currentTime=6.5;});await expect.poll(active,{timeout:4000}).toBe(false);
    // Если декодер не поддержан, стандартный ended всё ещё завершает воспроизведение.
    await page.evaluate(() => {window.savedOffline=window.OfflineAudioContext;window.OfflineAudioContext=undefined;});
    await row(5).locator('.voice-play').tap();await expect.poll(active).toBe(true);await expect.poll(active,{timeout:5000}).toBe(false);
    // Главное воспроизведение: Opus/MP4 с84с скачком, без помощи PCM-декодера.
    await row(6).locator('.voice-play').tap();await expect.poll(active).toBe(true);
    await page.waitForFunction(()=>Number.isFinite(window.voiceAudios.at(-1)?.duration)&&window.voiceAudios.at(-1).duration>0);
    const nativeDuration=await page.evaluate(()=>window.voiceAudios.at(-1).duration);
    assert.ok(Math.abs(nativeDuration-opus.duration)<.1,JSON.stringify({nativeDuration,expected:opus.duration}));
    await expect.poll(active,{timeout:5000}).toBe(false);
    await page.evaluate(() => window.OfflineAudioContext=window.savedOffline);
    // Переключение на другой плеер и удаление текущего вложения.
    await row(1).locator('.voice-play').tap();await row(2).locator('.voice-play').tap();await expect.poll(active).toBe(true);
    await page.evaluate(async () => (await import('/js/media.js')).forgetMedia('synthetic/pause.wav'));assert.equal(await active(),false);
    assert.equal(await page.evaluate(() => window.voiceTest.downloads),6);
    // Стенные часы скачут на 90 секунд, звуковая дорожка остаётся ~1,2 секунды.
    const recorded = await page.evaluate(async () => {
      const media = await import('/js/media.js'), recording = await media.startRecording(), realNow = Date.now;
      await new Promise(resolve => setTimeout(resolve,1200));Date.now = () => realNow() + 90000;
      try {const item = await recording.finish();return {duration:item.meta.duration,size:item.blob.size};} finally {Date.now=realNow;}
    });
    assert.ok(recorded.duration > .5 && recorded.duration < 5,JSON.stringify(recorded));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({recorded,downloads:6,formats:['WAV','AAC/MP4','Opus/MP4'],silenceTail:90,timestampGap:84,nativeOpusDuration:nativeDuration,errors}));
  } finally {if(browser) await browser.close();await new Promise(resolve => server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
});

// Фото и голосовые: подготовка к отправке, загрузка из хранилища, показ и проигрывание.
import {$, state, element, prefs, post} from './core.js';
import {mergeMessages} from './messages.js';
import {analyseVoice} from './voice-timing.js';
import {prepareVoicePlayback} from './voice-mp4.js';

// ===== Файлы из хранилища =====
// Файл скачивается один раз и остаётся на устройстве (Cache Storage), чтобы не тянуть его при каждом открытии.
const urls = new Map(), ready = new Map(); // ready — уже загруженные адреса: нужны, чтобы запустить звук прямо в момент нажатия
const cacheKey = path => location.origin + '/__media/' + (state.user?.id||'none') + '/' + path;
let mediaEpoch=0,activeDownloads=0;
const downloadQueue=[],lazyNodes=new Map();
function drain(){while(activeDownloads<2&&downloadQueue.length){const job=downloadQueue.shift();if(job.epoch!==mediaEpoch){job.reject(new Error('Вход изменился.'));continue;}activeDownloads++;Promise.resolve().then(job.run).then(job.resolve,job.reject).finally(()=>{activeDownloads--;drain();});}}
function download(run){return new Promise((resolve,reject)=>{downloadQueue.push({run,resolve,reject,epoch:mediaEpoch});drain();});}
const observer='IntersectionObserver' in window?new IntersectionObserver(entries=>entries.forEach(entry=>{const item=lazyNodes.get(entry.target);if(item){item.visible=entry.isIntersecting;if(item.visible)item.load();}}),{rootMargin:'160px'}):null;
function lazy(node,load){
  const item={visible:!observer,busy:false,done:false,attempts:0,timer:null,load:async()=>{
    if(item.busy||item.done||!item.visible||!node.isConnected)return;
    item.busy=true;const generation=mediaEpoch;
    try{await load();if(generation===mediaEpoch){item.done=true;observer?.unobserve(node);lazyNodes.delete(node);}}
    catch(_error){if(generation===mediaEpoch&&item.attempts++<3)item.timer=setTimeout(item.load,[1500,5000,15000][item.attempts-1]);}
    finally{item.busy=false;}
  }};
  lazyNodes.set(node,item);if(observer)observer.observe(node);else setTimeout(item.load,0);return ()=>{item.attempts=0;item.load();};
}
function retryVisible(){for(const [node,item] of lazyNodes){if(!node.isConnected){clearTimeout(item.timer);observer?.unobserve(node);lazyNodes.delete(node);}else {item.attempts=0;item.load();}}}
window.addEventListener('online',retryVisible);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)retryVisible();});
export function resetMedia(){
  mediaEpoch++;reset();for(const item of lazyNodes.values())clearTimeout(item.timer);lazyNodes.clear();observer?.disconnect();
  for(const item of ready.values())URL.revokeObjectURL(item.url);urls.clear();ready.clear();voiceTimings.clear();drain();
}
async function loadBlob(path, isCurrent) {
  const key=cacheKey(path);
  let store = null;
  try {store = 'caches' in window ? await caches.open('mayak-media') : null;} catch(_error) {store = null;}
  if(store) {const hit = await store.match(key).catch(() => null); if(hit) return hit.blob();}
  const blob = await download(()=>window.MayakCloud.download(path));
  if(store && isCurrent()) {
    await store.put(key, new Response(blob, {headers:{'Content-Type':blob.type || 'application/octet-stream'}})).catch(() => {});
    if(!isCurrent()) await store.delete(key).catch(() => {});
  }
  return blob;
}
export function mediaURL(path, voice = false) {
  if(!urls.has(path)) {
    const pending = loadBlob(path, () => urls.get(path) === pending).then(async blob => {
      const prepared = voice ? await prepareVoicePlayback(blob) : {blob, duration:null};
      if(urls.get(path) !== pending) throw new Error('Файл удалён из хранилища');
      const url = URL.createObjectURL(prepared.blob); ready.set(path, {url, ...prepared}); return url;
    });
    pending.catch(() => {if(urls.get(path) === pending) urls.delete(path);}); // не удалять более новую загрузку
    urls.set(path, pending);
  }
  return urls.get(path);
}
export async function mediaBlob(path) {
  await mediaURL(path);
  const item = ready.get(path);
  if(!item?.blob) throw new Error('Файл недоступен.');
  return item.blob;
}
// Только что отправленный файл уже есть на устройстве — показываем его без скачивания.
export function rememberMedia(path, blob) {const url = URL.createObjectURL(blob); ready.set(path, {url, blob}); urls.set(path, Promise.resolve(url)); voiceTimings.delete(path);}
export function forgetMedia(path) {
  if(player.id && state.messages.some(message => message.id === player.id && message.file === path)) reset();
  const old = urls.get(path); if(old) old.then(URL.revokeObjectURL).catch(() => {});
  urls.delete(path); ready.delete(path); voiceTimings.delete(path);
  if('caches' in window) caches.open('mayak-media').then(store => store.delete(cacheKey(path))).catch(() => {});
}

// ===== Фото =====
// Снимок с телефона весит несколько мегабайт — уменьшаем до 1600 точек по длинной стороне и сохраняем как JPEG.
const PHOTO_SIDE = 1600;
async function decode(file) {
  if(window.createImageBitmap) {
    try {return await createImageBitmap(file, {imageOrientation:'from-image'});} catch(_error) {}
  }
  return new Promise((resolve, reject) => {
    const image = new Image(), url = URL.createObjectURL(file);
    image.onload = () => {URL.revokeObjectURL(url); resolve(image);};
    image.onerror = () => {URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать фото. Выберите другое.'));};
    image.src = url;
  });
}
export async function preparePhoto(file) {
  if(!file || !/^image\//.test(file.type || '')) throw new Error('Это не фото. Выберите изображение.');
  let image;
  try {image = await decode(file);} catch(_error) {throw new Error('Не удалось прочитать фото. Выберите другое.');}
  const width = image.width || image.naturalWidth, height = image.height || image.naturalHeight;
  if(!width || !height) throw new Error('Не удалось прочитать фото. Выберите другое.');
  const scale = Math.min(1, PHOTO_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); // прозрачный фон в JPEG стал бы чёрным
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if(image.close) image.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
  if(!blob) throw new Error('Не удалось подготовить фото.');
  return {kind:'photo', blob, extension:'jpg', meta:{w:canvas.width, h:canvas.height, size:blob.size, mime:'image/jpeg'}};
}
// PNG сохраняет прозрачные края стикера; анимированные изображения пока становятся статичными.
export async function prepareSticker(file) {
  if(!file || !/^image\//.test(file.type || '')) throw new Error('Выберите изображение для стикера.');
  if(file.size > 16 * 1024 * 1024) throw new Error('Картинка слишком большая для стикера.');
  let image;
  try {image = await decode(file);} catch(_error) {throw new Error('Не удалось прочитать стикер.');}
  try {
    const width=image.width || image.naturalWidth, height=image.height || image.naturalHeight;
    if(!width || !height || width * height > 40000000) throw new Error('Не удалось прочитать стикер.');
    // APNG использует тот же допустимый image/png и сохраняет анимацию без перекодирования.
    if(['image/png','image/apng'].includes(file.type) && file.size<=4*1024*1024 && width<=512 && height<=512){
      const bytes=new Uint8Array(await file.arrayBuffer()),view=new DataView(bytes.buffer);let animated=false;
      if(bytes.length>=8 && bytes[0]===137 && bytes[1]===80 && bytes[2]===78 && bytes[3]===71){
        for(let offset=8;offset+12<=bytes.length;){const length=view.getUint32(offset);if(offset+12+length>bytes.length)break;if(bytes[offset+4]===97&&bytes[offset+5]===99&&bytes[offset+6]===84&&bytes[offset+7]===76&&length===8&&view.getUint32(offset+8)>1){animated=true;break;}offset+=12+length;}
      }
      if(animated)return {kind:'photo',sticker:true,blob:new Blob([bytes],{type:'image/png'}),extension:'png',meta:{w:width,h:height,size:file.size,mime:'image/png'}};
    }
    const scale=Math.min(1,512/Math.max(width,height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(!blob || blob.size>4*1024*1024)throw new Error('Не удалось подготовить стикер.');
    return {kind:'photo',sticker:true,blob,extension:'png',meta:{w:canvas.width,h:canvas.height,size:blob.size,mime:'image/png'}};
  } finally {if(image.close) image.close();}
}
export function isSticker(message) {return message?.kind==='photo' && /\/sticker-[a-f0-9]{24}\.png$/.test(message.file || '') && message.file_meta?.mime==='image/png';}
export function photoNode(message) {
  const meta = message.file_meta || {};
  // Не кнопка, а блок: долгое нажатие на фото должно открывать меню сообщения, как и на тексте.
  const frame = element('div', 'message-photo' + (isSticker(message) ? ' message-sticker' : '')); frame.dataset.photo = message.id;
  frame.setAttribute('role', 'button'); frame.tabIndex = 0; frame.setAttribute('aria-label', isSticker(message)?'Стикер':'Открыть фото');
  if(meta.w > 0 && meta.h > 0) frame.style.aspectRatio = meta.w + ' / ' + meta.h; // место под фото — заранее, чтобы лента не прыгала
  const image = element('img'); image.alt = isSticker(message)?'Стикер':'Фото'; image.decoding = 'async'; image.draggable = false;
  frame.appendChild(image);
  const note=element('span','media-retry','Нажми, чтобы загрузить');frame.appendChild(note);
  const retry=lazy(frame,async()=>{try{const url=await mediaURL(message.file);image.src=url;frame.classList.remove('failed');note.hidden=true;}catch(error){frame.classList.add('failed');note.textContent=error.status===404?'Файл удалён':'Загрузка прервалась · Повторить';throw error;}});
  frame.addEventListener('click',event=>{if(!image.src||frame.classList.contains('failed')){event.stopPropagation();retry();}},true);
  return frame;
}
export function openViewer(id) {
  const message = state.messages.find(item => item.id === id);
  if(!message || !message.file) return;
  mediaURL(message.file).then(url => {if(!state.messages.some(current => current.id === id && current.file === message.file && !current.deleted)) return; $('viewer-image').src = url; $('viewer-layer').hidden = false;}).catch(() => {});
}
export function closeViewer() {$('viewer-layer').hidden = true; $('viewer-image').removeAttribute('src');}

// ===== Голосовые =====
export function clock(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}
const FORMATS = [['audio/mp4;codecs=mp4a.40.2','m4a'], ['audio/mp4','m4a'], ['audio/webm;codecs=opus','webm'], ['audio/webm','webm'], ['audio/ogg;codecs=opus','ogg']];
export function canRecord() {return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);}
// Начинает запись. finish() отдаёт готовое вложение, cancel() отбрасывает запись.
export async function startRecording() {
  if(!canRecord()) throw new Error('Это устройство не умеет записывать голос в браузере.');
  let stream;
  try {stream = await navigator.mediaDevices.getUserMedia({audio:true});}
  catch(_error) {throw new Error('Нет доступа к микрофону. Разрешите его в настройках телефона или браузера.');}
  const format = FORMATS.find(item => MediaRecorder.isTypeSupported(item[0])) || ['', 'webm'];
  let recorder;
  try {recorder = new MediaRecorder(stream, format[0] ? {mimeType:format[0], audioBitsPerSecond:32000} : undefined);}
  catch(_error) {stream.getTracks().forEach(track => track.stop()); throw new Error('Не удалось начать запись.');}
  const chunks = [], started = Date.now();
  recorder.addEventListener('dataavailable', event => {if(event.data && event.data.size) chunks.push(event.data);});
  const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, {once:true}));
  recorder.start(1000);
  const release = () => stream.getTracks().forEach(track => track.stop());
  return {
    started,
    async finish() {
      const duration = (Date.now() - started) / 1000;
      if(recorder.state !== 'inactive') recorder.stop();
      await stopped; release();
      const mime = (recorder.mimeType || format[0] || 'audio/webm').split(';')[0];
      const prepared = await prepareVoicePlayback(new Blob(chunks, {type:mime})), blob = prepared.blob;
      if(duration < .7 || !blob.size) throw new Error('Слишком короткая запись.');
      const timing = await analyseVoice(blob);
      return {kind:'voice', blob, extension:format[1], meta:{duration:Math.round((timing?.end || prepared.duration || duration) * 10) / 10, size:blob.size, mime}};
    },
    cancel() {try {if(recorder.state !== 'inactive') recorder.stop();} catch(_error) {} release();}
  };
}
// Скорость воспроизведения запоминается на устройстве и действует на все голосовые.
const SPEEDS = [1, 1.5, 2];
function speed() {const value = Number(prefs.get('voice.speed', '1')); return SPEEDS.includes(value) ? value : 1;}
const speedLabel = () => String(speed()).replace('.', ',') + '×';
export function nextSpeed() {
  prefs.set('voice.speed', String(SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length]));
  if(player.audio) player.audio.playbackRate = speed();
  $('messages').querySelectorAll('.voice-speed').forEach(node => {node.textContent = speedLabel();});
}
// Чужое голосовое, которое я ещё не слушал, помечается точкой; после запуска отметка уходит автору («прослушано»).
const unheard = message => !!state.user && message.user_id !== state.user.id && !(message.heard || []).includes(state.user.id);
export function voiceNode(message) {
  const box = element('div', 'message-voice' + (unheard(message) ? ' unheard' : '')); box.dataset.voice = message.id;
  const play = element('button', 'voice-play', '▶'); play.type = 'button'; play.setAttribute('aria-label', 'Слушать голосовое сообщение');
  const bar = element('div', 'voice-bar'); bar.appendChild(element('i'));
  const rate = element('button', 'voice-speed', speedLabel()); rate.type = 'button'; rate.setAttribute('aria-label', 'Скорость воспроизведения');
  box.appendChild(play); box.appendChild(bar); box.appendChild(element('span', 'voice-time', clock(voiceDuration(message)))); box.appendChild(rate);
  if(player.id === message.id) paint(box);
  lazy(box,()=>mediaURL(message.file,true)); // готовим только записи возле видимой области
  return box;
}
// Одновременно играет одно голосовое. Строка сообщения может быть пересоздана, поэтому ищем её заново.
const player = {audio:null, id:null, loading:false, timer:null};
const voiceTimings = new Map();
let analysisQueue = Promise.resolve();
function voiceDuration(message, audio) {
  const end = voiceTimings.get(message?.file)?.result?.end || ready.get(message?.file)?.duration;
  if(end > 0) return end;
  return audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(message?.file_meta?.duration) || 0;
}
function checkVoiceEnd() {
  const audio = player.audio, message = state.messages.find(item => item.id === player.id);
  const end = voiceTimings.get(message?.file)?.result?.end || ready.get(message?.file)?.duration;
  if(audio && !audio.paused && end > 0 && audio.currentTime >= end) reset();
  else paint();
}
function inspectVoice(path) {
  if(voiceTimings.has(path)) return voiceTimings.get(path).pending;
  const entry = {result:null, pending:null}, source = ready.get(path);
  if(!source) return Promise.resolve(null);
  // Не декодируем сразу всю историю и не держим несколько PCM-буферов одновременно.
  entry.pending = analysisQueue = analysisQueue.catch(() => {}).then(async () => {
    if(ready.get(path) !== source) return;
    const result = await analyseVoice(source.blob);
    if(ready.get(path) !== source || voiceTimings.get(path) !== entry) return;
    entry.result = result;
    if(player.audio && state.messages.find(item => item.id === player.id)?.file === path) checkVoiceEnd();
    else for(const message of state.messages.filter(item => item.file === path)) {
      const node = $('messages').querySelector('[data-voice="' + message.id + '"] .voice-time');
      if(node) node.textContent = clock(voiceDuration(message));
    }
  });
  if(voiceTimings.size >= 100) voiceTimings.delete(voiceTimings.keys().next().value);
  voiceTimings.set(path, entry);
  return entry.pending;
}
export const voicePlaying = () => !!(player.audio && (player.loading || !player.audio.paused && !player.audio.ended));
function paint(box) {
  const node = box || $('messages').querySelector('[data-voice="' + player.id + '"]');
  if(!node || !player.audio) return;
  const message = state.messages.find(item => item.id === player.id);
  const total = voiceDuration(message, player.audio);
  const playing = !player.audio.paused && !player.audio.ended;
  node.classList.toggle('playing', playing);
  node.querySelector('.voice-play').textContent = playing ? '❚❚' : '▶';
  node.querySelector('.voice-bar i').style.width = (total ? Math.min(100, player.audio.currentTime / total * 100) : 0) + '%';
  node.querySelector('.voice-time').textContent = clock(playing || player.audio.currentTime ? player.audio.currentTime : total);
}
function reset() {
  const node = player.id ? $('messages').querySelector('[data-voice="' + player.id + '"]') : null;
  clearInterval(player.timer); player.timer = null;
  if(player.audio) {const audio = player.audio; player.audio = null; audio.pause(); audio.removeAttribute('src'); audio.load();}
  const message = state.messages.find(item => item.id === player.id);
  player.id = null; player.loading = false;
  if(node) {
    node.classList.remove('playing'); node.querySelector('.voice-play').textContent = '▶';
    node.querySelector('.voice-bar i').style.width = '0%';
    node.querySelector('.voice-time').textContent = clock(voiceDuration(message));
  }
}
export function stopVoice() {reset();}
export async function toggleVoice(id) {
  document.dispatchEvent(new Event('mayak-audio-start'));
  if(player.id === id && player.audio) {
    if(player.audio.paused) player.audio.play().catch(() => {}); else player.audio.pause();
    return;
  }
  reset();
  const message = state.messages.find(item => item.id === id);
  if(!message || !message.file) return;
  // Звук создаётся сразу по нажатию — иначе телефон не разрешит его запустить после загрузки файла.
  const audio = new Audio(); player.audio = audio; player.id = id; player.loading = true;
  ['play','pause','timeupdate','loadedmetadata','durationchange'].forEach(type => audio.addEventListener(type, () => {if(player.audio === audio) checkVoiceEnd();}));
  audio.addEventListener('ended', () => {if(player.audio === audio) reset();});
  audio.addEventListener('error', () => {if(player.audio === audio) reset();});
  try {
    // Телефон разрешает звук только прямо в момент нажатия: если файл уже загружен, запускаем без ожидания.
    if(ready.has(message.file)) audio.src = ready.get(message.file).url;
    else {audio.src = await mediaURL(message.file, true); if(player.audio !== audio) return;}
    audio.playbackRate = speed();
    const playing = audio.play(); // остаётся в цепочке нажатия для iPhone
    inspectVoice(message.file).catch(() => {});
    player.timer = setInterval(() => {if(player.audio === audio) checkVoiceEnd();}, 100);
    await playing;
    if(player.audio !== audio) return;
    audio.playbackRate = speed(); // некоторые браузеры сбрасывают скорость при запуске
    if(unheard(message)) post('heard', {id}).then(result => {if(result.message && result.message.id) mergeMessages([result.message], 'changed');}).catch(() => {});
  } catch(error) {if(player.audio !== audio) return; reset(); throw new Error('Не удалось проиграть запись.');}
  finally {if(player.audio === audio) player.loading = false;}
}

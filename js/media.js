// Фото и голосовые: подготовка к отправке, загрузка из хранилища, показ и проигрывание.
import {$, state, element, prefs, post} from './core.js';
import {mergeMessages} from './messages.js';

// ===== Файлы из хранилища =====
// Файл скачивается один раз и остаётся на устройстве (Cache Storage), чтобы не тянуть его при каждом открытии.
const urls = new Map(), ready = new Map(); // ready — уже загруженные адреса: нужны, чтобы запустить звук прямо в момент нажатия
const cacheKey = path => location.origin + '/__media/' + path;
async function loadBlob(path) {
  let store = null;
  try {store = 'caches' in window ? await caches.open('mayak-media') : null;} catch(_error) {store = null;}
  if(store) {const hit = await store.match(cacheKey(path)).catch(() => null); if(hit) return hit.blob();}
  const blob = await window.MayakCloud.download(path);
  if(store) store.put(cacheKey(path), new Response(blob, {headers:{'Content-Type':blob.type || 'application/octet-stream'}})).catch(() => {});
  return blob;
}
export function mediaURL(path) {
  if(!urls.has(path)) {
    const pending = loadBlob(path).then(blob => {const url = URL.createObjectURL(blob); ready.set(path, url); return url;});
    pending.catch(() => urls.delete(path)); // не удалось — в следующий раз попробуем снова
    urls.set(path, pending);
  }
  return urls.get(path);
}
// Только что отправленный файл уже есть на устройстве — показываем его без скачивания.
export function rememberMedia(path, blob) {const url = URL.createObjectURL(blob); ready.set(path, url); urls.set(path, Promise.resolve(url));}
export function forgetMedia(path) {
  urls.delete(path); ready.delete(path);
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
export function photoNode(message) {
  const meta = message.file_meta || {};
  // Не кнопка, а блок: долгое нажатие на фото должно открывать меню сообщения, как и на тексте.
  const frame = element('div', 'message-photo'); frame.dataset.photo = message.id;
  frame.setAttribute('role', 'button'); frame.tabIndex = 0; frame.setAttribute('aria-label', 'Открыть фото');
  if(meta.w > 0 && meta.h > 0) frame.style.aspectRatio = meta.w + ' / ' + meta.h; // место под фото — заранее, чтобы лента не прыгала
  const image = element('img'); image.alt = 'Фото'; image.decoding = 'async'; image.draggable = false;
  frame.appendChild(image);
  mediaURL(message.file).then(url => {image.src = url;}).catch(() => {frame.classList.add('failed'); frame.textContent = 'Фото недоступно';});
  return frame;
}
export function openViewer(id) {
  const message = state.messages.find(item => item.id === id);
  if(!message || !message.file) return;
  mediaURL(message.file).then(url => {$('viewer-image').src = url; $('viewer-layer').hidden = false;}).catch(() => {});
}
export function closeViewer() {$('viewer-layer').hidden = true; $('viewer-image').removeAttribute('src');}

// ===== Голосовые =====
export function clock(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}
const FORMATS = [['audio/mp4','m4a'], ['audio/webm;codecs=opus','webm'], ['audio/webm','webm'], ['audio/ogg;codecs=opus','ogg']];
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
      const blob = new Blob(chunks, {type:mime});
      if(duration < .7 || !blob.size) throw new Error('Слишком короткая запись.');
      return {kind:'voice', blob, extension:format[1], meta:{duration:Math.round(duration * 10) / 10, size:blob.size, mime}};
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
  const meta = message.file_meta || {};
  const box = element('div', 'message-voice' + (unheard(message) ? ' unheard' : '')); box.dataset.voice = message.id;
  const play = element('button', 'voice-play', '▶'); play.type = 'button'; play.setAttribute('aria-label', 'Слушать голосовое сообщение');
  const bar = element('div', 'voice-bar'); bar.appendChild(element('i'));
  const rate = element('button', 'voice-speed', speedLabel()); rate.type = 'button'; rate.setAttribute('aria-label', 'Скорость воспроизведения');
  box.appendChild(play); box.appendChild(bar); box.appendChild(element('span', 'voice-time', clock(meta.duration))); box.appendChild(rate);
  if(player.id === message.id) paint(box);
  mediaURL(message.file).catch(() => {}); // запись маленькая — загружаем заранее, чтобы по нажатию заиграла сразу
  return box;
}
// Одновременно играет одно голосовое. Строка сообщения может быть пересоздана, поэтому ищем её заново.
const player = {audio:null, id:null};
function paint(box) {
  const node = box || $('messages').querySelector('[data-voice="' + player.id + '"]');
  if(!node || !player.audio) return;
  const message = state.messages.find(item => item.id === player.id);
  const total = Number.isFinite(player.audio.duration) && player.audio.duration > 0 ? player.audio.duration : Number((message && message.file_meta || {}).duration) || 0;
  const playing = !player.audio.paused && !player.audio.ended;
  node.classList.toggle('playing', playing);
  node.querySelector('.voice-play').textContent = playing ? '❚❚' : '▶';
  node.querySelector('.voice-bar i').style.width = (total ? Math.min(100, player.audio.currentTime / total * 100) : 0) + '%';
  node.querySelector('.voice-time').textContent = clock(playing || player.audio.currentTime ? player.audio.currentTime : total);
}
function reset() {
  const node = player.id ? $('messages').querySelector('[data-voice="' + player.id + '"]') : null;
  if(player.audio) {player.audio.pause(); player.audio = null;}
  const message = state.messages.find(item => item.id === player.id);
  player.id = null;
  if(node) {
    node.classList.remove('playing'); node.querySelector('.voice-play').textContent = '▶';
    node.querySelector('.voice-bar i').style.width = '0%';
    node.querySelector('.voice-time').textContent = clock((message && message.file_meta || {}).duration);
  }
}
export function stopVoice() {reset();}
export async function toggleVoice(id) {
  if(player.id === id && player.audio) {
    if(player.audio.paused) player.audio.play().catch(() => {}); else player.audio.pause();
    return;
  }
  reset();
  const message = state.messages.find(item => item.id === id);
  if(!message || !message.file) return;
  // Звук создаётся сразу по нажатию — иначе телефон не разрешит его запустить после загрузки файла.
  const audio = new Audio(); player.audio = audio; player.id = id;
  ['play','pause','timeupdate','loadedmetadata'].forEach(type => audio.addEventListener(type, () => {if(player.audio === audio) paint();}));
  audio.addEventListener('ended', () => {if(player.audio === audio) reset();});
  audio.addEventListener('error', () => {if(player.audio === audio) reset();});
  try {
    // Телефон разрешает звук только прямо в момент нажатия: если файл уже загружен, запускаем без ожидания.
    if(ready.has(message.file)) audio.src = ready.get(message.file);
    else {audio.src = await mediaURL(message.file); if(player.audio !== audio) return;}
    audio.playbackRate = speed();
    await audio.play();
    audio.playbackRate = speed(); // некоторые браузеры сбрасывают скорость при запуске
    if(unheard(message)) post('heard', {id}).then(result => {if(result.message && result.message.id) mergeMessages([result.message], 'changed');}).catch(() => {});
  } catch(error) {if(player.audio === audio) reset(); throw new Error('Не удалось проиграть запись.');}
}

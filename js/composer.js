// Поле ввода: отправка, ответ и изменение, «печатает», сохранение черновика.
import {$, state, post, prefs, snippet, toast, MAIN, roomPeer} from './core.js';
import {messageById, mergeMessages, connection} from './messages.js';
import {followViewport} from './viewport.js';
import {preparePhoto, startRecording, canRecord, clock, rememberMedia} from './media.js';
import {recordVideo,canRecordVideo,cancelVideoRecording} from './video.js';

let typingSent = 0, draftTimer = null, recording = null, recordTimer = null;
const MAX_RECORDING = 300; // секунд
function newNonce() {const random = new Uint32Array(4); crypto.getRandomValues(random); return Array.from(random).map(value => value.toString(16)).join('-');}

export function resizeComposer() {
  const input = $('message-input');
  input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 130) + 'px';
  const filled = !!input.value.trim() || !!state.attachment;
  $('send-button').disabled = state.sending || !filled;
  // Пока писать нечего, на месте кнопки отправки — микрофон.
  const voice = canRecord() && !filled && !state.editing;
  $('voice-button').hidden = !voice; $('send-button').hidden = voice;
  $('attach-button').hidden = !!state.editing;
  $('camera-button').hidden = !(window.MAYAK_CONFIG||{}).videoEnabled || !canRecordVideo() || filled || !!state.editing;
  $('camera-button').disabled = state.sending;
  $('attach-button').disabled = state.sending;
  $('voice-button').disabled = state.sending;
  $('attachment-cancel').disabled = state.sending;
}
// Полоса над полем ввода: выбранное фото или неотправленная запись.
function renderAttachment() {
  const item = state.attachment;
  $('attachment-bar').hidden = !item;
  if(!item) {$('attachment-thumb').removeAttribute('src'); return;}
  const photo = item.kind === 'photo';
  $('attachment-title').textContent = photo ? 'Фото' : (item.kind==='video'?'Видеокружочек':'Голосовое') + ' · ' + clock(item.meta.duration);
  $('attachment-text').textContent = photo ? 'Добавьте подпись или отправьте так' : 'Не отправлено — нажмите «отправить»';
  $('attachment-thumb').hidden = !photo;
  if(photo) $('attachment-thumb').src = item.preview;
}
function clearAttachment() {
  if(state.attachment && state.attachment.preview) URL.revokeObjectURL(state.attachment.preview);
  state.attachment = null; renderAttachment(); resizeComposer();
}
async function pickPhoto(file) {
  try {
    const item = await preparePhoto(file);
    clearAttachment();
    item.preview = URL.createObjectURL(item.blob); state.attachment = item;
    renderAttachment(); resizeComposer();
  } catch(error) {toast(error.message);}
}
function recordTick() {
  if(!recording) return;
  const seconds = (Date.now() - recording.started) / 1000;
  $('record-time').textContent = clock(seconds);
  if(seconds >= MAX_RECORDING) endRecording(true);
}
async function beginRecording() {
  if(recording || state.sending) return;
  try {recording = await startRecording();} catch(error) {toast(error.message); return;}
  $('message-form').hidden = true; $('record-bar').hidden = false; followViewport(1500);
  recordTick(); recordTimer = setInterval(recordTick, 250);
}
async function endRecording(send) {
  const current = recording; recording = null; clearInterval(recordTimer);
  $('record-bar').hidden = true; $('message-form').hidden = false; followViewport(2000);
  if(!current) return;
  if(!send) {current.cancel(); return;}
  try {
    const item = await current.finish();
    clearAttachment(); state.attachment = item; renderAttachment(); resizeComposer();
    await submit({preventDefault() {}});
  } catch(error) {toast(error.message);}
}
// Полоса над полем ввода: на что отвечаем или что изменяем.
export function renderContext() {
  const id = state.editing || state.reply, message = id ? messageById(id) : null;
  if(!message || message.deleted) {
    if(state.editing) $('message-input').value = '';
    state.editing = null; state.reply = null; $('composer-context').hidden = true; return;
  }
  $('context-title').textContent = state.editing ? 'Изменение сообщения' : 'Ответ · ' + message.name;
  $('context-text').textContent = snippet(message.text);
  $('composer-context').hidden = false;
}
export function startReply(id) {
  if(state.editing) $('message-input').value = '';
  state.editing = null; state.reply = id; renderContext(); $('message-input').focus(); resizeComposer(); saveDraft();
}
export function startEdit(id) {
  const message = messageById(id); if(!message) return;
  saveDraft(); // недописанное сообщение останется в черновике
  state.reply = null; state.editing = id; $('message-input').value = message.text; renderContext(); $('message-input').focus(); resizeComposer();
}
export function cancelContext() {
  const editing = !!state.editing;
  state.editing = null; state.reply = null;
  if(editing) restoreDraft(); else saveDraft();
  renderContext(); resizeComposer();
}

function typingSignal() {
  if(!state.user) return;
  if($('message-input').value.trim() && !state.editing) {
    if(Date.now() - typingSent > 3000) {typingSent = Date.now(); post('typing', {on:true, peer:roomPeer()}).catch(() => {});}
  } else if(typingSent) {typingSent = 0; post('typing', {on:false, peer:roomPeer()}).catch(() => {});}
}

// При уходе из чата: там мы больше не печатаем.
export function stopTyping() {if(typingSent && state.user) {typingSent = 0; post('typing', {on:false, peer:roomPeer()}).catch(() => {});}}
// Черновик хранится на устройстве отдельно для каждого участника и каждого чата и переживает перезапуск приложения.
// Вместе с текстом сохраняется номер отправки: если сообщение ушло, а ответ не дошёл, повтор не создаст дубль.
const draftKey = () => 'draft:' + state.user.id + (state.room === MAIN ? '' : ':' + state.room);
export function saveDraft() {
  clearTimeout(draftTimer);
  if(!state.user || state.editing) return;
  const text = $('message-input').value, reply = state.reply || null;
  if(!text.trim() && !reply) {prefs.set(draftKey(), null); return;}
  const nonce = state.draft && state.draft.text === text.trim() && state.draft.reply === reply ? state.draft.nonce : null;
  prefs.set(draftKey(), JSON.stringify({text, reply, nonce}));
}
export function restoreDraft() {
  const input = $('message-input');
  let saved = null;
  try {saved = JSON.parse(prefs.get(draftKey(), 'null'));} catch(_error) {saved = null;}
  input.value = saved && typeof saved.text === 'string' ? saved.text.slice(0, 2000) : '';
  state.reply = saved && Number(saved.reply) ? Number(saved.reply) : null;
  state.draft = saved && saved.nonce && input.value.trim() ? {text:input.value.trim(), reply:state.reply, nonce:String(saved.nonce)} : null;
  if(!state.attachment){
    try {const pending=JSON.parse(prefs.get('pending-video:'+state.user.id,'null'));if(pending&&pending.room===state.room){state.attachment={...pending,kind:'video'};renderAttachment();}}catch(_error){}
  }
  resizeComposer();
}
// При выходе: поле очищается, а с forget=true стирается и сохранённый черновик.
export function resetComposer(forget) {
  clearTimeout(draftTimer);
  if(forget && state.user) prefs.set(draftKey(), null);
  if(recording) endRecording(false);
  cancelVideoRecording();
  state.sending=false;
  clearAttachment();
  $('message-input').value = ''; state.draft = null; state.reply = null; state.editing = null; typingSent = 0;
  $('composer-context').hidden = true; $('send-error').hidden = true; resizeComposer();
}

async function submit(event) {
  event.preventDefault();
  const input = $('message-input'), text = input.value.trim();
  if((!text && !state.attachment) || state.sending) return;
  const submittingUser=state.user?.id;
  state.sending = true; $('send-button').disabled = true; $('send-error').hidden = true;
  try {
    if(state.editing) {
      const original = messageById(state.editing);
      if(original && original.text !== text) mergeMessages([(await post('edit', {id:state.editing, text})).message], 'changed');
      state.editing = null; restoreDraft(); renderContext();
    } else if(state.attachment?.kind==='video') {
      const item=state.attachment,userId=state.user.id;
      if(!item.nonce)item.nonce=newNonce();
      const persist=()=>prefs.set('pending-video:'+userId,JSON.stringify({room:item.room,peer:item.peer,reply:item.reply,nonce:item.nonce,path:item.path,job:item.job,meta:item.meta}));
      if(!item.path){item.path=await window.MayakCloud.videoUpload(item.blob,item.extension);persist();}
      const started=await post('video-start',{file:item.path,nonce:item.nonce,peer:item.peer||null,reply:item.reply||null});item.job=started.job.id;persist();
      const waitingSince=Date.now();let result;
      while(state.user?.id===userId){
        result=await post('video-status',{id:item.job});
        if(result.job.state==='sent')break;
        if(['failed','cancelled'].includes(result.job.state))throw Object.assign(new Error(result.job.error||'Запись отменена.'),{status:422});
        $('attachment-text').textContent='Видео обрабатывается…';
        if(Date.now()-waitingSince>135000)throw Object.assign(new Error('Видео ещё обрабатывается. Повторите отправку чуть позже — дубля не будет.'),{status:408});
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      if(state.user?.id!==userId)return;
      prefs.set('pending-video:'+userId,null);
      if(state.attachment===item)clearAttachment();
      state.reply=null;renderContext();saveDraft();mergeMessages([result.message],'sent');
    } else if(state.attachment) {
      // Сначала файл уходит в хранилище, потом создаётся сообщение. Путь и номер отправки запоминаются:
      // если связь оборвалась на втором шаге, повтор не загружает файл заново и не создаёт дубль.
      const item = state.attachment;
      if(!item.nonce) item.nonce = newNonce();
      if(!item.path) {item.path = await window.MayakCloud.upload(item.blob, item.extension); rememberMedia(item.path, item.blob);} // свой файл не скачиваем обратно
      const result = await post('attach', {kind:item.kind, file:item.path, meta:item.meta, text:item.kind === 'photo' ? text : '', nonce:item.nonce, reply:state.reply || null, peer:roomPeer()});
      if(item.kind === 'photo') input.value = '';
      state.draft = null; state.reply = null; typingSent = 0;
      clearAttachment(); saveDraft(); renderContext(); mergeMessages([result.message], 'sent');
    } else {
      const reply = state.reply || null;
      if(!state.draft || state.draft.text !== text || state.draft.reply !== reply) state.draft = {text, reply, nonce:newNonce()};
      saveDraft();
      const result = await post('messages', {...state.draft, peer:roomPeer()});
      input.value = ''; state.draft = null; state.reply = null; typingSent = 0;
      saveDraft(); renderContext(); mergeMessages([result.message], 'sent');
    }
    connection(true);
  } catch(error) {
    if(state.user?.id!==submittingUser)return;
    $('send-error').textContent = error.status ? error.message : state.attachment?.kind==='video'?'Отправка прервалась. Нажмите отправить ещё раз — готовая запись не продублируется.':'Не отправлено. Текст сохранён — нажмите отправить ещё раз, когда связь вернётся.';
    // A returned HTTP error still proves the cloud is reachable; keep the retryable attachment.
    $('send-error').hidden = false; connection(!!error.status);
  } finally {if(!state.user||state.user.id===submittingUser){state.sending = false; resizeComposer();}}
}

export function initComposer() {
  const input = $('message-input');
  $('message-form').addEventListener('submit', submit);
  input.addEventListener('input', () => {resizeComposer(); typingSignal(); clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 300);});
  input.addEventListener('keydown', event => {
    if(event.key === 'Enter' && !event.shiftKey && window.innerWidth > 760 && !event.isComposing) {
      event.preventDefault();
      if($('message-form').requestSubmit) $('message-form').requestSubmit(); else $('send-button').click();
    }
  });
  $('context-cancel').addEventListener('click', cancelContext);
  $('attach-button').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', () => {const file = $('photo-input').files[0]; $('photo-input').value = ''; if(file) pickPhoto(file);});
  $('attachment-cancel').addEventListener('click',async()=>{
    const item=state.attachment;if(state.sending)return;
    if(item?.kind==='video'){
      try {if(item.job)await post('video-cancel',{id:item.job});if(item.path)window.MayakCloud.videoSourceRemove(item.path).catch(()=>{});prefs.set('pending-video:'+state.user.id,null);}
      catch(error){toast(error.message);return;}
    }
    clearAttachment();
  });
  $('camera-button').addEventListener('click',()=>{
    const user=state.user?.id,room=state.room,peer=roomPeer(),reply=state.reply;
    recordVideo(item=>{if(state.user?.id!==user)return;clearAttachment();state.attachment={...item,room,peer,reply};renderAttachment();resizeComposer();submit({preventDefault(){}});});
  });
  $('voice-button').addEventListener('click', beginRecording);
  $('record-send').addEventListener('click', () => endRecording(true));
  $('record-cancel').addEventListener('click', () => endRecording(false));
  // Телефон может выгрузить приложение без предупреждения — сохраняем, как только оно уходит с экрана.
  window.addEventListener('pagehide', saveDraft);
  document.addEventListener('visibilitychange', () => {if(document.hidden) saveDraft();});
}

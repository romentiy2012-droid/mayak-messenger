// Поле ввода: отправка, ответ и изменение, «печатает», сохранение черновика.
import {$, state, post, prefs, snippet, toast, MAIN, roomPeer} from './core.js';
import {messageById, mergeMessages, connection} from './messages.js';
import {followViewport} from './viewport.js';
import {preparePhoto, startRecording, canRecord, clock, rememberMedia} from './media.js';

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
}
// Полоса над полем ввода: выбранное фото или неотправленная запись.
function renderAttachment() {
  const item = state.attachment;
  $('attachment-bar').hidden = !item;
  if(!item) {$('attachment-thumb').removeAttribute('src'); return;}
  const photo = item.kind === 'photo';
  $('attachment-title').textContent = photo ? 'Фото' : 'Голосовое · ' + clock(item.meta.duration);
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
  resizeComposer();
}
// При выходе: поле очищается, а с forget=true стирается и сохранённый черновик.
export function resetComposer(forget) {
  clearTimeout(draftTimer);
  if(forget && state.user) prefs.set(draftKey(), null);
  if(recording) endRecording(false);
  clearAttachment();
  $('message-input').value = ''; state.draft = null; state.reply = null; state.editing = null; typingSent = 0;
  $('composer-context').hidden = true; $('send-error').hidden = true; resizeComposer();
}

async function submit(event) {
  event.preventDefault();
  const input = $('message-input'), text = input.value.trim();
  if((!text && !state.attachment) || state.sending) return;
  state.sending = true; $('send-button').disabled = true; $('send-error').hidden = true;
  try {
    if(state.editing) {
      const original = messageById(state.editing);
      if(original && original.text !== text) mergeMessages([(await post('edit', {id:state.editing, text})).message], 'changed');
      state.editing = null; restoreDraft(); renderContext();
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
    $('send-error').textContent = error.status ? error.message : 'Не отправлено. Текст сохранён — нажмите отправить ещё раз, когда связь вернётся.';
    $('send-error').hidden = false; connection(false);
  } finally {state.sending = false; resizeComposer();}
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
  $('attachment-cancel').addEventListener('click', clearAttachment);
  $('voice-button').addEventListener('click', beginRecording);
  $('record-send').addEventListener('click', () => endRecording(true));
  $('record-cancel').addEventListener('click', () => endRecording(false));
  // Телефон может выгрузить приложение без предупреждения — сохраняем, как только оно уходит с экрана.
  window.addEventListener('pagehide', saveDraft);
  document.addEventListener('visibilitychange', () => {if(document.hidden) saveDraft();});
}

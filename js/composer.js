// Поле ввода: отправка, ответ и изменение, «печатает», сохранение черновика.
import {$, state, post, prefs, snippet} from './core.js';
import {messageById, mergeMessages, connection} from './messages.js';

let typingSent = 0, draftTimer = null;

export function resizeComposer() {
  const input = $('message-input');
  input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 130) + 'px';
  $('send-button').disabled = state.sending || !input.value.trim();
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
    if(Date.now() - typingSent > 3000) {typingSent = Date.now(); post('typing', {on:true}).catch(() => {});}
  } else if(typingSent) {typingSent = 0; post('typing', {on:false}).catch(() => {});}
}

// Черновик хранится на устройстве отдельно для каждого участника и переживает перезапуск приложения.
// Вместе с текстом сохраняется номер отправки: если сообщение ушло, а ответ не дошёл, повтор не создаст дубль.
const draftKey = () => 'draft:' + state.user.id;
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
  $('message-input').value = ''; state.draft = null; state.reply = null; state.editing = null; typingSent = 0;
  $('composer-context').hidden = true; $('send-error').hidden = true; resizeComposer();
}

async function submit(event) {
  event.preventDefault();
  const input = $('message-input'), text = input.value.trim();
  if(!text || state.sending) return;
  state.sending = true; $('send-button').disabled = true; $('send-error').hidden = true;
  try {
    if(state.editing) {
      const original = messageById(state.editing);
      if(original && original.text !== text) mergeMessages([(await post('edit', {id:state.editing, text})).message], 'changed');
      state.editing = null; restoreDraft(); renderContext();
    } else {
      const reply = state.reply || null;
      if(!state.draft || state.draft.text !== text || state.draft.reply !== reply) {
        const random = new Uint32Array(4); crypto.getRandomValues(random);
        state.draft = {text, reply, nonce:Array.from(random).map(value => value.toString(16)).join('-')};
      }
      saveDraft();
      const result = await post('messages', state.draft);
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
  // Телефон может выгрузить приложение без предупреждения — сохраняем, как только оно уходит с экрана.
  window.addEventListener('pagehide', saveDraft);
  document.addEventListener('visibilitychange', () => {if(document.hidden) saveDraft();});
}

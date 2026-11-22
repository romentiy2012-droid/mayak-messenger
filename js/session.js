// Вход и выход, экран входа, получение сообщений из облака.
import {$, api, state, prefs, paintAvatar, palette, MAIN} from './core.js';
import {clearAvatarPhotos} from './avatars.js';
import {pushBanner, pushSync, pushFlags, clearNotifications} from './push.js';
import {adjustViewport} from './viewport.js';
import {mergeMessages, renderMessages, renderPeople, connection, memberChanged, readsLoaded, readChanged, setMainName, clearTyping, resetList, markRead} from './messages.js';
import {restoreDraft, resetComposer} from './composer.js';
import {closeSheet} from './actions.js';
import {stopVoice, closeViewer, resetMedia} from './media.js';
import {resetVideos} from './video.js';
import {loadHistory, saveHistory, forgetAccount, activateAccount} from './offline.js';
import {restoreOutbox, resetOutbox, flushOutbox} from './outbox.js';

let generation = 0, timer = null, bootTask = null;
let presenceTask=null, snapshotTimer=null;
function snapshot() {
  if(!state.user||!state.verified)return;
  const user=state.user.id, counts={}, older={...state.older};
  const messages=state.messages.slice().reverse().filter(message=>{const room=message.peer_a?(message.peer_a===user?message.peer_b:message.peer_a):MAIN;counts[room]=(counts[room]||0)+1;if(counts[room]>100){older[room]=true;return false;}return true;}).reverse();
  saveHistory(user,{session:{user:state.user,room:'Наш круг'},messages,people:state.people,reads:state.reads,read:state.read,older,rev:state.rev,directFull:state.directFull}).catch(()=>{});
}
document.addEventListener('mayak-history-changed',()=>{clearTimeout(snapshotTimer);snapshotTimer=setTimeout(snapshot,150);});
document.addEventListener('mayak-auth-required',event=>{showJoin();$('join-error').textContent=event.detail?.message||'Войдите в чат.';});
function presence() {
  if(presenceTask||!window.MayakCloud.presence||!state.user)return;
  const current=generation;
  presenceTask=window.MayakCloud.presence().then(result=>{
    if(current!==generation||!state.user)return;
    if(result.people)state.people=result.people;
    if(result.reads)readsLoaded(result.reads);
    renderPeople();renderMessages('changed');snapshot();
  }).catch(()=>{}).finally(()=>{presenceTask=null;});
}

// До решения о сессии форма скрыта и отключена уже в исходном HTML:
// менеджеру паролей не нужно предлагать вход при обычном открытии чата.
function joinVisible(visible) {
  $('welcome').hidden = !visible;
  $('welcome').inert = !visible;
  $('join-fields').disabled = !visible;
}
function showStartup(error = false) {
  joinVisible(false); $('chat').hidden = true; $('startup').hidden = false;
  $('startup').setAttribute('aria-busy', String(!error));
  $('startup-status').textContent = error ? 'Не удалось подключиться. Проверьте интернет и попробуйте ещё раз.' : 'Открываем чат…';
  $('startup-retry').hidden = !error;
  adjustViewport();
}

function clearAddress() {if(location.hash) history.replaceState(null, '', location.pathname + location.search);}
export function showChat(session, cached=false) {
  state.user = session.user; state.room = MAIN; state.older = {}; state.reads = []; state.directFull = false;
  state.verified=!cached;activateAccount(state.user.id);restoreOutbox();
  state.read = {[MAIN]:Number(session.user.last_read) || 0};
  state.invitation = ''; state.resetToken = ''; clearAddress();
  // Оформление «терминал» — только у владельца; у остальных всегда обычное.
  prefs.set('owner', state.user.owner ? '1' : null);
  if(window.MayakTheme) window.MayakTheme.apply();
  joinVisible(false); $('startup').hidden = true; $('chat').hidden = false;
  setMainName(session.room);
  document.querySelectorAll('.room-name').forEach(node => {node.textContent = session.room || 'Наш круг';});
  $('chat').classList.remove('direct');
  $('my-name').textContent = state.user.name;
  [$('my-avatar'), $('mobile-avatar')].forEach(node => {node.className = 'avatar ' + palette(state.user.id); paintAvatar(node, state.user);});
  $('invite-button').hidden = !state.user.owner;
  restoreDraft();
  adjustViewport();
  pushBanner(); clearNotifications();
  if(!cached&&!pushFlags.get('off')) pushSync(false).catch(() => {});
}
// Экран входа в трёх видах: вход, регистрация, новый пароль по ссылке владельца.
export function renderJoin() {
  const reset = !!state.resetToken;
  if(state.invitation && !reset) $('join-mode').value = 'register';
  const register = !reset && $('join-mode').value === 'register';
  $('join-identity').hidden = reset; $('reset-note').hidden = !reset; $('reset-cancel').hidden = !reset;
  $('join-name').required = !reset; $('join-name').maxLength = register ? 32 : 80;
  $('join-name').placeholder = register ? 'Как вас называть в чате' : 'Имя, с которым регистрировались';
  $('password-label').textContent = reset ? 'Новый пароль' : 'Пароль';
  $('password-note').hidden = reset;
  $('join-password').autocomplete = reset || register ? 'new-password' : 'current-password';
  $('join-button').firstChild.textContent = reset ? 'Сохранить пароль и войти ' : register ? 'Создать аккаунт и войти ' : 'Войти в чат ';
  $('invite-field').hidden = reset || !!state.invitation || !register;
}
// forget=true — участник сам вышел: черновик на устройстве стирается.
export function showJoin(forget) {
  const previous=state.user?.id||window.MayakCloud.cachedUserId?.();
  if(previous)forgetAccount(previous).catch(()=>{});
  state.verified=false;clearTimeout(snapshotTimer);resetOutbox();resetMedia();
  generation++; window.MayakCloud.stop();
  clearAvatarPhotos();
  resetVideos();
  clearTimeout(timer);
  resetComposer(forget);
  state.messages = []; state.people = []; state.rev = 0; state.older = {}; state.read = {}; state.reads = []; state.room = MAIN; state.inviteURL = '';
  clearTyping(); stopVoice(); closeViewer(); resetList(); closeSheet();
  $('people-list').replaceChildren(); $('jump-button').hidden = true;
  try {if(navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});} catch(_error) {}
  state.user = null; document.dispatchEvent(new Event('mayak-context-changed')); $('chat').hidden = true; $('startup').hidden = true; joinVisible(true); $('push-banner').hidden = true; $('install-banner').hidden = true;
  renderJoin(); connection(state.online);
  adjustViewport();
}
export async function poll(initial = false) {
  if(!state.user) return;
  if(!state.verified){boot();return;}
  if(state.polling) {state.again = true; return;}
  state.polling = true; state.again = false;
  const current = generation;
  let more = false;
  presence();
  window.MayakCloud.watch((kind,row)=>{
    if(current!==generation||!state.user)return;
    if(kind==='member')memberChanged(row);
    else if(kind==='read')readChanged(row);
    else poll();
  });
  try {
    const result = await api('events?rev=' + state.rev);
    if(current !== generation || !state.user) return;
    const first = !state.rev;
    if(first) {state.older[MAIN] = result.has_older; state.directFull = !!result.direct_full;}
    const before = state.people;
    if(result.people)state.people = result.people;
    const directRead = result.reads?readsLoaded(result.reads):false;
    mergeMessages(result.messages, initial || first ? 'initial' : 'new');
    if(!result.messages.length && (directRead || before.some(person => {const now = state.people.find(item => item.id === person.id); return now && Number(now.last_read) !== Number(person.last_read);}))) renderMessages('changed');
    renderPeople(); connection(true);markRead();
    snapshot();flushOutbox();
    more = result.has_more;
  } catch(error) {
    if(current !== generation) return;
    connection(false);
    if(error.status === 401 || error.status === 403) {showJoin(); $('join-error').textContent = error.message;}
  } finally {
    state.polling = false; clearTimeout(timer);
    if(state.user) timer = setTimeout(() => poll(), more || state.again ? 100 : 15000);
  }
}
async function checkCloud() {
  try {await api('health'); connection(true);} catch(_error) {connection(false);}
}
async function restoreSession() {
  // Ссылка для сброса пароля важнее сохранённого входа: участник пришёл задать новый пароль.
  if(state.resetToken) {showJoin(); checkCloud(); return;}
  if(state.user&&state.verified) return;
  const current = generation;
  if(!state.user)showStartup();
  renderJoin();
  const cachedId=window.MayakCloud.cachedUserId?.();
  if(!state.user&&cachedId){
    try{
      const saved=await loadHistory(cachedId);
      if(current!==generation)return;
      if(saved?.session?.user?.id===cachedId){
        showChat(saved.session,true);state.people=saved.people||[];state.read=saved.read||{};state.reads=saved.reads||[];state.older=saved.older||{};state.directFull=!!saved.directFull;
        mergeMessages(saved.messages||[],'initial');state.rev=Number(saved.rev)||0;renderPeople();connection(false);
      }
    }catch(_error){}
  }
  try {
    const session = await api('session');
    if(current !== generation) return;
    if(state.user?.id===session.user.id){state.user=session.user;state.verified=true;activateAccount(session.user.id);}
    else {if(state.user)showJoin();showChat(session);}
    await poll(!state.rev);
  }
  catch(error) {
    if(current !== generation) return;
    if(error.status === 401 || error.status === 403) {
      showJoin();
      if(error.status === 401) checkCloud();
      else $('join-error').textContent = error.message;
    } else {
      // Сбой сети/сервера не означает выход: сохранённую сессию не трогаем.
      connection(false);if(!state.user)showStartup(true);
      clearTimeout(timer);timer=setTimeout(boot,5000);
    }
  }
}
export function boot() {
  if(!bootTask || bootTask.generation !== generation) {
    const task = {generation, promise:null};
    bootTask = task;
    task.promise = restoreSession().finally(() => {if(bootTask === task) bootTask = null;});
  }
  return bootTask.promise;
}

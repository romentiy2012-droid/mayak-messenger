// Вход и выход, экран входа, получение сообщений из облака.
import {$, api, state, initials, palette} from './core.js';
import {pushBanner, pushSync, pushFlags, clearNotifications} from './push.js';
import {adjustViewport} from './viewport.js';
import {mergeMessages, renderMessages, renderPeople, connection, memberChanged, clearTyping, resetList} from './messages.js';
import {restoreDraft, resetComposer} from './composer.js';
import {closeSheet} from './actions.js';

let generation = 0, timer = null;

function clearAddress() {if(location.hash) history.replaceState(null, '', location.pathname + location.search);}
export function showChat(session) {
  state.user = session.user; state.readUpTo = Number(session.user.last_read) || 0;
  state.invitation = ''; state.resetToken = ''; clearAddress();
  $('welcome').hidden = true; $('chat').hidden = false;
  document.querySelectorAll('.room-name').forEach(node => {node.textContent = session.room || 'Наш круг';});
  $('my-name').textContent = state.user.name;
  [$('my-avatar'), $('mobile-avatar')].forEach(node => {node.textContent = initials(state.user.name); node.className = 'avatar ' + palette(state.user.id);});
  $('invite-button').hidden = !state.user.owner;
  restoreDraft();
  adjustViewport();
  pushBanner(); clearNotifications();
  if(!pushFlags.get('off')) pushSync(false).catch(() => {});
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
  generation++; window.MayakCloud.stop();
  clearTimeout(timer);
  resetComposer(forget);
  state.messages = []; state.people = []; state.rev = 0; state.older = false; state.inviteURL = ''; state.readUpTo = 0;
  clearTyping(); resetList(); closeSheet();
  $('people-list').replaceChildren(); $('jump-button').hidden = true;
  try {if(navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});} catch(_error) {}
  state.user = null; $('chat').hidden = true; $('welcome').hidden = false; $('push-banner').hidden = true;
  renderJoin(); connection(state.online);
  adjustViewport();
}
export async function poll(initial = false) {
  if(!state.user) return;
  if(state.polling) {state.again = true; return;}
  state.polling = true; state.again = false;
  const current = generation;
  let more = false;
  try {
    const result = await api('events?rev=' + state.rev);
    if(current !== generation || !state.user) return;
    const first = !state.rev;
    if(first) state.older = result.has_older;
    const before = state.people;
    state.people = result.people;
    mergeMessages(result.messages, initial || first ? 'initial' : 'new');
    if(!result.messages.length && before.some(person => {const now = state.people.find(item => item.id === person.id); return now && Number(now.last_read) !== Number(person.last_read);})) renderMessages('changed');
    renderPeople(); connection(true);
    more = result.has_more;
    window.MayakCloud.watch((kind, row) => {
      if(!state.user) return;
      if(kind === 'member') memberChanged(row);
      else if(kind !== 'message' || (row.rev || 0) > state.rev) poll();
    });
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
export async function boot() {
  // Ссылка для сброса пароля важнее сохранённого входа: участник пришёл задать новый пароль.
  if(state.resetToken) {showJoin(); checkCloud(); return;}
  renderJoin();
  try {const session = await api('session'); showChat(session); await poll(true);}
  catch(error) {
    showJoin();
    if(error.status === 401) checkCloud();
    else {connection(false); $('join-error').textContent = error.message || 'Не удалось подключиться к облаку.';}
  }
}

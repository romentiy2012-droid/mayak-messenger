// Маяк: точка входа. Собирает модули из js/ и подключает события страницы.
//   core — состояние и помощники · session — вход и получение сообщений · messages — лента
//   composer — поле ввода и черновики · actions — меню сообщения и жесты · dialogs — окна
//   push — уведомления · viewport — высота и клавиатура · sound — сигнал
import {$, api, post, state, toast, MAIN, roomOf} from './js/core.js';
import {adjustViewport, followViewport} from './js/viewport.js';
import {unlockAudio} from './js/sound.js';
import {pushEnable, pushBanner, pushFlags, clearNotifications} from './js/push.js';
import {mergeMessages, markRead, connection} from './js/messages.js';
import {initComposer} from './js/composer.js';
import {initActions} from './js/actions.js';
import {initDialogs} from './js/dialogs.js';
import {showChat, showJoin, renderJoin, poll, boot} from './js/session.js';

initComposer(); initActions(); initDialogs();

$('join-form').addEventListener('submit', async event => {
  event.preventDefault(); $('join-error').textContent = ''; $('join-button').disabled = true;
  const password = $('join-password').value;
  try {
    let result;
    if(state.resetToken) {
      result = await post('reset', {token:state.resetToken, password});
      toast('Пароль изменён. Для входа: ' + result.login);
    } else {
      const register = $('join-mode').value === 'register', name = $('join-name').value.trim();
      if(register && name.includes('@')) throw Object.assign(new Error('При регистрации укажите имя, а не почту.'), {status:400});
      let invite = state.invitation || $('join-invite').value.trim();
      if(invite.includes('#')) {try {invite = new URLSearchParams(new URL(invite).hash.slice(1)).get('invite') || invite;} catch(_error) {}}
      result = await post('join', {name, register, password, invite});
    }
    $('join-password').value = ''; showChat(result); await poll(true);
  } catch(error) {$('join-error').textContent = error.status ? error.message : 'Облако недоступно. Проверьте интернет и попробуйте ещё раз.';}
  finally {$('join-button').disabled = false;}
});
$('join-mode').addEventListener('change', renderJoin);
$('reset-cancel').addEventListener('click', () => {
  state.resetToken = ''; history.replaceState(null, '', location.pathname + location.search); $('join-error').textContent = ''; boot();
});
$('older-button').addEventListener('click', async () => {
  // История подгружается для открытого чата: общего либо личного (пара участников).
  const room = state.room, first = state.messages.find(message => roomOf(message) === room);
  if(!first) return; $('older-button').disabled = true;
  const scope = room === MAIN ? '&main=1' : '&a=' + (state.user.id < room ? state.user.id : room) + '&b=' + (state.user.id < room ? room : state.user.id);
  try {const result = await api('messages?before=' + first.id + scope); state.older[room] = result.has_older; mergeMessages(result.messages, 'older');}
  catch(error) {toast(error.message);} finally {$('older-button').disabled = false;}
});
$('push-enable').addEventListener('click', pushEnable);
$('push-dismiss').addEventListener('click', () => {pushFlags.set('later', true); pushBanner();});

document.addEventListener('pointerdown', unlockAudio, {passive:true});
window.addEventListener('online', () => {if(state.user) poll(); else boot();});
window.addEventListener('offline', () => connection(false));
window.addEventListener('hashchange', () => {
  const hash = new URLSearchParams(location.hash.slice(1)), invite = hash.get('invite'), reset = hash.get('reset');
  if(reset) {state.resetToken = reset; showJoin();}
  else if(invite) {state.invitation = invite; if(!state.user) showJoin();}
});
window.addEventListener('resize', adjustViewport);
if(window.visualViewport) {window.visualViewport.addEventListener('resize', adjustViewport); window.visualViewport.addEventListener('scroll', adjustViewport);}
$('message-input').addEventListener('focus', () => followViewport(1500));
$('message-input').addEventListener('blur', () => followViewport(800));
document.addEventListener('visibilitychange', () => {
  if(document.hidden) return;
  document.title = 'Маяк — свои на связи';
  if(state.user) {clearNotifications(); markRead(); poll();}
});

if('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'}).catch(() => {});
adjustViewport(); boot();

// Окна: приглашение, участники и имя, сброс пароля, установка, настройки.
import {$, api, post, state, prefs, element, button, avatar, paintAvatar, adminTag, toast, copyText, problem,MAIN,roomPeer} from './core.js';
import {avatarEditor} from './avatars.js';
import {pushSupported, pushActive, pushEnable, pushDisable} from './push.js';
import {unlockAudio, ping} from './sound.js';
import {poll, showJoin} from './session.js';
import {chatList, openRoom, lastSeen,mergeMessages,roomTitle} from './messages.js';
import {storageWindow} from './storage.js';
import {pollEditor} from './polls.js';
import {adjustViewport, followViewport, revealDialogFocus} from './viewport.js';

let previousFocus = null, cleanup = null, saving = false;
function dialog(title, opener = document.activeElement) {
  document.dispatchEvent(new Event('mayak-expression-close'));
  if(cleanup) {cleanup(); cleanup = null;}
  previousFocus = opener;
  if(document.activeElement?.isContentEditable || document.activeElement?.matches('input,textarea,select')) document.activeElement.blur();
  const content = $('dialog-content'); content.replaceChildren(element('h2', '', title)); content.firstChild.id = 'dialog-title';
  $('dialog-layer').hidden = false; adjustViewport(); $('dialog-close').focus({preventScroll:true}); return content;
}
export function closeDialog() {if(saving) return; if(cleanup) {cleanup(); cleanup = null;} $('dialog-layer').hidden = true; if(previousFocus && previousFocus.focus) previousFocus.focus({preventScroll:true}); followViewport(800);}
function attachmentDialog(){
 if(!state.user||state.sending||state.editing)return;
 const content=dialog('Добавить в чат');
 content.appendChild(button('Фото',()=>{closeDialog();$('photo-input').click();},'primary-button'));
 const create=button('Опрос',()=>{
  const user=state.user.id,room=state.room,reply=state.reply||null,body=dialog('Новый опрос');
  body.appendChild(element('p','about-note',room===MAIN?'В общий чат':'Лично: '+roomTitle(room)));
  cleanup=pollEditor(body,{room,peer:roomPeer(),reply,onBusy:value=>{saving=value;},onDone:closeDialog,onSent:message=>{
   if(state.user?.id!==user)return;
   if(state.room===room&&state.reply===reply){state.reply=null;document.dispatchEvent(new Event('mayak-poll-sent'));}
   mergeMessages([message],state.room===room?'sent':'changed');
  }});
 },'primary-button');
 create.disabled=!!state.attachment;content.appendChild(create);
 if(state.attachment)content.appendChild(element('p','about-note','Перед созданием опроса отправь или убери выбранное вложение.'));
}
// Ссылка с кнопками «скопировать» и «отправить».
function shareLink(content, url, copyLabel, share) {
  content.appendChild(element('div', 'link-field', url));
  content.appendChild(button(copyLabel, () => copyText(url).then(() => toast('Ссылка скопирована')).catch(error => toast(error.message)), 'primary-button'));
  if(navigator.share) content.appendChild(button('Отправить ссылку…', () => navigator.share({...share, url}).catch(() => {})));
}
async function inviteDialog() {
  const content = dialog('Позовите своих');
  content.appendChild(element('p', '', 'Одноразовое приглашение на 7 дней: даёт доступ ко всей истории. Новое приглашение отменяет предыдущее неиспользованное. Отправляйте только своим.'));
  try {
    state.inviteURL = (await api('invite')).url;
    shareLink(content, state.inviteURL, 'Скопировать приглашение', {title:'Маяк — наш круг', text:'Заходи в наш чат'});
  } catch(error) {content.appendChild(element('p', 'form-error', problem(error)));}
}
async function resetDialog(person) {
  const content = dialog('Новый пароль для участника');
  content.appendChild(element('p', '', '«' + person.name + '» откроет эту ссылку и задаст новый пароль. Ссылка одноразовая, действует сутки; новая отменяет предыдущую. Отправляйте только самому участнику — по ней можно войти в его аккаунт.'));
  try {
    const url = (await post('reset-link', {id:person.id})).url;
    shareLink(content, url, 'Скопировать ссылку', {title:'Маяк — новый пароль', text:'Ссылка, чтобы задать новый пароль в Маяке'});
  } catch(error) {content.appendChild(element('p', 'form-error', problem(error)));}
}
// Список чатов на телефоне (на широком экране он всегда слева).
function chatsDialog() {
  const content = dialog('Чаты');
  const list = element('div', 'chat-list');
  list.appendChild(chatList(room => {closeDialog(); openRoom(room);}));
  content.appendChild(list);
  content.appendChild(element('p', 'about-note', 'Общий чат видят все участники. Личный чат с человеком видите только вы двое.'));
}
function kickDialog(person) {
  const content = dialog('Удалить участника?');
  content.appendChild(element('p', '', '«' + person.name + '» сразу потеряет доступ к чату и перестанет получать уведомления. Его сообщения останутся в истории. Вернуть участника можно новым приглашением.'));
  const errorNode = element('p', 'form-error'); content.appendChild(errorNode);
  const confirm = button('Удалить из чата', async () => {
    confirm.disabled = true;
    try {await post('kick', {id:person.id}); closeDialog(); toast('Участник удалён'); poll();}
    catch(error) {errorNode.textContent = problem(error); confirm.disabled = false;}
  }, 'primary-button danger-button');
  content.appendChild(confirm);
  content.appendChild(button('Отмена', profileDialog));
}
function profileDialog() {
  const content = dialog('Ваш круг');
  const active = state.people.filter(person => person.online).length;
  content.appendChild(element('p', '', state.people.length + ' участников · ' + active + ' сейчас в сети'));
  const list = element('div', 'people-list');
  state.people.forEach(person => {
    const row = element('div', 'person' + (person.online ? ' online' : '')); row.appendChild(avatar(person));
    const name = element('span', 'person-name', person.name + (person.id === state.user.id ? ' · вы' : '')); if(person.owner) name.appendChild(adminTag());
    name.appendChild(element('span', 'person-note', lastSeen(person)));
    row.appendChild(name);
    if(state.user.owner && person.id !== state.user.id) {
      row.appendChild(button('Пароль', () => resetDialog(person), 'person-action'));
      row.appendChild(button('Удалить', () => kickDialog(person), 'person-action danger'));
    }
    list.appendChild(row);
  });
  content.appendChild(list);
  if(state.user.owner && state.people.length > 1) content.appendChild(element('p', 'about-note', '«Пароль» — отправить участнику ссылку, если он забыл пароль. «Удалить» — убрать участника из чата.'));
  const form = element('form', 'profile-in-dialog');
  const editor = avatarEditor(state.user); form.appendChild(editor.node); cleanup = () => editor.dispose();
  const label = element('label', '', 'Ваше имя в чате'); label.htmlFor = 'profile-name'; form.appendChild(label);
  const input = element('input'); input.id = 'profile-name'; input.value = state.user.name; input.maxLength = 32; input.required = true; form.appendChild(input);
  form.appendChild(element('p', 'about-note', 'Меняется только подпись в чате. Для входа остаётся имя, с которым вы регистрировались.'));
  const errorNode = element('p', 'form-error'); form.appendChild(errorNode);
  const submit = element('button', 'primary-button', 'Сохранить профиль'); submit.type = 'submit'; form.appendChild(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if(editor.busy()) {errorNode.textContent = 'Дождитесь подготовки фото.'; return;}
    saving = true; submit.disabled = true; editor.disable(true); input.disabled = true; errorNode.textContent = ''; submit.textContent = 'Сохраняем…';
    try {
      const oldFile = state.user.avatar_file;
      const result = await post('profile', {name:input.value, ...await editor.value()});
      editor.commit();
      state.user = result.user; $('my-name').textContent = state.user.name;
      const index = state.people.findIndex(person => person.id === state.user.id);
      if(index >= 0) state.people[index] = {...state.people[index], ...state.user};
      [$('my-avatar'), $('mobile-avatar')].forEach(node => paintAvatar(node, state.user));
      if(oldFile && oldFile !== state.user.avatar_file) window.MayakCloud.avatarRemove(oldFile).catch(() => {});
      saving = false; closeDialog(); toast('Профиль сохранён'); poll();
    } catch(error) {errorNode.textContent = problem(error);} finally {saving = false; submit.disabled = false; editor.disable(false); input.disabled = false; submit.textContent = 'Сохранить профиль';}
  });
  content.insertBefore(form, list);
}
export async function installApp() {
  if(state.install) {const prompt = state.install; state.install = null; await prompt.prompt(); const result = await prompt.userChoice; if(result.outcome === 'accepted') $('install-button').hidden = true; return result.outcome;}
  const content = dialog('Маяк на главном экране');
  content.appendChild(element('p', '', 'Открывайте чат отдельным приложением, без адресной строки браузера.'));
  const list = element('ol');
  list.appendChild(element('li', '', 'Android: откройте меню браузера ⋮ и выберите «Установить приложение» или «Добавить на главный экран».'));
  list.appendChild(element('li', '', 'iPhone: откройте ссылку в Safari, нажмите «Поделиться» → «На экран Домой».'));
  content.appendChild(list);
  content.appendChild(element('p', 'about-note', 'Для переписки нужен интернет. На iPhone уведомления работают только у приложения, добавленного на экран Домой.'));
}
function aboutDialog() {
  const content = dialog('Небольшой чат для своих');
  content.appendChild(element('p', '', '«Маяк» работает в облаке. Здесь одна общая переписка, а первый вход — по приглашению.'));
  content.appendChild(button('Чаты', chatsDialog));
  content.appendChild(button('Установить приложение', installApp));
  content.appendChild(button(state.user.owner ? 'Профиль, участники и пароли' : 'Профиль и участники', profileDialog));
  if(state.user.owner) content.appendChild(button('Пригласить друзей', inviteDialog));
  if(state.user.owner) content.appendChild(button('Хранилище и лимиты', () => {if(!state.user?.owner)return;const content=dialog('Хранилище и лимиты');cleanup=storageWindow(content);}));
  if(pushSupported()) {
    const toggle = button('Уведомления…', async () => {
      toggle.disabled = true;
      try {if(await pushActive()) {await pushDisable(false); toast('Уведомления отключены на этом устройстве');} else await pushEnable();}
      catch(error) {toast(error.message || 'Не удалось изменить уведомления');}
      closeDialog();
    });
    content.appendChild(toggle);
    pushActive().then(active => {toggle.textContent = active ? 'Отключить уведомления' : 'Включить уведомления';}).catch(() => {});
  } else content.appendChild(element('p', 'about-note', /iP(hone|ad|od)/.test(navigator.userAgent) ? 'Уведомления на iPhone: откройте чат в Safari, «Поделиться» → «На экран Домой», затем включите их в установленном приложении (нужна iOS 16.4 или новее).' : 'Этот браузер не поддерживает уведомления.'));
  if(window.MayakTheme && !state.user.owner) {
    const names = {auto:'как в телефоне', light:'светлая', dark:'тёмная'}, order = ['auto','light','dark'];
    const theme = button('', () => {window.MayakTheme.set(order[(order.indexOf(window.MayakTheme.get()) + 1) % order.length]); theme.textContent = 'Тема: ' + names[window.MayakTheme.get()];});
    theme.textContent = 'Тема: ' + (names[window.MayakTheme.get()] || names.auto); content.appendChild(theme);
  }
  // Оформление «терминал» — только для владельца.
  if(window.MayakTheme && state.user.owner) {
    const names = {auto:'как в телефоне', light:'светлая', dark:'тёмная'}, order = ['auto','light','dark'];
    const skins = {terminal:'терминал', classic:'обычное'};
    const skin = button('', () => {window.MayakTheme.setSkin(window.MayakTheme.skin() === 'terminal' ? 'classic' : 'terminal'); skin.textContent = 'Оформление: ' + skins[window.MayakTheme.skin()]; theme.hidden = window.MayakTheme.skin() === 'terminal';});
    skin.textContent = 'Оформление: ' + skins[window.MayakTheme.skin()]; content.appendChild(skin);
    const theme = button('', () => {window.MayakTheme.set(order[(order.indexOf(window.MayakTheme.get()) + 1) % order.length]); theme.textContent = 'Тема: ' + names[window.MayakTheme.get()];});
    theme.textContent = 'Тема: ' + (names[window.MayakTheme.get()] || names.auto); theme.hidden = window.MayakTheme.skin() === 'terminal'; content.appendChild(theme);
  }
  const sound = button('', () => {const on = prefs.get('sound','1') !== '1'; prefs.set('sound', on ? '1' : '0'); sound.textContent = 'Звук сообщений: ' + (on ? 'включён' : 'выключен'); if(on) {unlockAudio(); ping();}});
  sound.textContent = 'Звук сообщений: ' + (prefs.get('sound','1') === '1' ? 'включён' : 'выключен'); content.appendChild(sound);
  content.appendChild(element('p', 'about-note', 'Действия с сообщением — ответ, реакция, изменение, удаление — открываются долгим нажатием на него. Чтобы ответить быстро, смахните сообщение влево.' + (state.user.owner ? ' Вы — админ: можете удалить любое сообщение общего чата и участника.' : '')));
  content.appendChild(element('p', 'about-note', state.user.owner ? 'Забыли свой пароль владельца — он меняется в Supabase: Authentication → Users.' : 'Забыли пароль — попросите владельца чата прислать ссылку для сброса.'));
  content.appendChild(element('p', 'about-note', 'История хранится в Supabase. Соединение защищено HTTPS; сквозного шифрования нет. О новых сообщениях приходят push-уведомления, если они включены на устройстве.'));
  content.appendChild(element('p', 'about-note', 'Маяк 2.22.2 · облачная версия.'));
  content.appendChild(button('Выйти на этом устройстве', async () => {
    try {await pushDisable(true).catch(() => {}); await post('logout', {}); closeDialog(); showJoin(true);}
    catch(error) {toast(problem(error));}
  }));
}

export function initDialogs() {
  $('dialog-layer').addEventListener('focusin', event => {
    revealDialogFocus();
    if(event.target.matches('input,textarea,select') || event.target.isContentEditable) followViewport(1500);
  });
  $('dialog-layer').addEventListener('focusout', () => followViewport(800));
  document.addEventListener('mayak-attachments',attachmentDialog);
  $('invite-button').addEventListener('click', inviteDialog);
  $('profile-button').addEventListener('click', profileDialog);
  $('mobile-profile').addEventListener('click', profileDialog);
  $('more-button').addEventListener('click', aboutDialog);
  $('chats-button').addEventListener('click', chatsDialog);
  $('install-button').addEventListener('click', installApp);
  $('dialog-close').addEventListener('click', closeDialog);
  $('dialog-layer').addEventListener('click', event => {if(event.target === $('dialog-layer')) closeDialog();});
  document.addEventListener('keydown', event => {
    if($('dialog-layer').hidden) return;
    if(event.key === 'Escape') closeDialog();
    if(event.key === 'Tab') {
      const nodes = Array.from($('dialog-layer').querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[contenteditable="true"],a[href]')).filter(node=>!node.hidden&&node.getClientRects().length); const first = nodes[0], last = nodes[nodes.length - 1];
      if(event.shiftKey && document.activeElement === first) {last.focus(); event.preventDefault();}
      else if(!event.shiftKey && document.activeElement === last) {first.focus(); event.preventDefault();}
    }
  });
  window.addEventListener('beforeinstallprompt', event => {event.preventDefault(); state.install = event; $('install-button').hidden = false;});
  window.addEventListener('appinstalled', () => {$('install-button').hidden = true; toast('Маяк добавлен на главный экран');});
}

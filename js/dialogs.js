// Окна: приглашение, участники и имя, сброс пароля, установка, настройки.
import {$, api, post, state, prefs, element, button, avatar, adminTag, initials, toast, copyText, problem} from './core.js';
import {pushSupported, pushActive, pushEnable, pushDisable} from './push.js';
import {unlockAudio, ping} from './sound.js';
import {poll, showJoin} from './session.js';
import {chatList, openRoom, lastSeen} from './messages.js';

let previousFocus = null;
function dialog(title) {
  previousFocus = document.activeElement;
  const content = $('dialog-content'); content.replaceChildren(element('h2', '', title)); content.firstChild.id = 'dialog-title';
  $('dialog-layer').hidden = false; $('dialog-close').focus(); return content;
}
export function closeDialog() {$('dialog-layer').hidden = true; if(previousFocus && previousFocus.focus) previousFocus.focus();}
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
  const label = element('label', '', 'Ваше имя в чате'); label.htmlFor = 'profile-name'; form.appendChild(label);
  const input = element('input'); input.id = 'profile-name'; input.value = state.user.name; input.maxLength = 32; input.required = true; form.appendChild(input);
  form.appendChild(element('p', 'about-note', 'Меняется только подпись в чате. Для входа остаётся имя, с которым вы регистрировались.'));
  const errorNode = element('p', 'form-error'); form.appendChild(errorNode);
  const submit = element('button', 'primary-button', 'Сохранить имя'); submit.type = 'submit'; form.appendChild(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try {
      const result = await post('profile', {name:input.value});
      state.user = result.user; $('my-name').textContent = state.user.name;
      [$('my-avatar'), $('mobile-avatar')].forEach(node => {node.textContent = initials(state.user.name);});
      closeDialog(); toast('Имя сохранено'); poll();
    } catch(error) {errorNode.textContent = problem(error);} finally {submit.disabled = false;}
  });
  content.appendChild(form);
}
async function installApp() {
  if(state.install) {const prompt = state.install; state.install = null; await prompt.prompt(); const result = await prompt.userChoice; if(result.outcome === 'accepted') $('install-button').hidden = true; return;}
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
  content.appendChild(button(state.user.owner ? 'Участники, имя и пароли' : 'Участники и ваше имя', profileDialog));
  if(state.user.owner) content.appendChild(button('Пригласить друзей', inviteDialog));
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
  content.appendChild(element('p', 'about-note', 'Маяк 2.9.0 · облачная версия.'));
  content.appendChild(button('Выйти на этом устройстве', async () => {
    try {await pushDisable(true).catch(() => {}); await post('logout', {}); closeDialog(); showJoin(true);}
    catch(error) {toast(problem(error));}
  }));
}

export function initDialogs() {
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
      const nodes = $('dialog-layer').querySelectorAll('button:not([disabled]),input,a[href]'); const first = nodes[0], last = nodes[nodes.length - 1];
      if(event.shiftKey && document.activeElement === first) {last.focus(); event.preventDefault();}
      else if(!event.shiftKey && document.activeElement === last) {first.focus(); event.preventDefault();}
    }
  });
  window.addEventListener('beforeinstallprompt', event => {event.preventDefault(); state.install = event; $('install-button').hidden = false;});
  window.addEventListener('appinstalled', () => {$('install-button').hidden = true; toast('Маяк добавлен на главный экран');});
}

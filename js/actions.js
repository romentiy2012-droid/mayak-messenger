// Действия с сообщением: меню, реакции, удаление, переход к цитате, жесты на телефоне.
import {$, state, post, problem, toast, button, element, copyText, MAIN, roomOf} from './core.js';
import {messageById, mergeMessages, markRead} from './messages.js';
import {startReply, startEdit} from './composer.js';
import {scrollBottom} from './viewport.js';
import {openViewer, closeViewer, toggleVoice, stopVoice, forgetMedia, nextSpeed} from './media.js';
import {stopVideo,forgetVideo} from './video.js';
import {showMessageMenu, setMessageMenuPanels, hideMessageMenu} from './message-menu.js';

const QUICK = ['👍','❤️','😂','😮','😢','🙏'];
// Остальные смайлы — по кнопке «＋». Любой другой можно ввести с клавиатуры в поле под ними.
const MORE = ['😀','😁','😅','🤣','😊','😍','😘','🥰','😎','🤔','🙄','😏','😴','🤗','🤝','👏','🙌','💪','👌','✌️','🤞','👀','🔥','💯','✨','🎉','🎂','🌹','💐','☀️','🌙','⭐','💔','💙','💚','🧡','😭','😱','😡','🤯','🥺','😇','🤡','💩','👎','🤦','🤷','🙈','🍻','☕','🍕','🚀','✅','❌','❓','❗'];
function firstSymbol(text) {
  const value = (text || '').trim(); if(!value) return '';
  if(window.Intl && Intl.Segmenter) {const part = new Intl.Segmenter('ru', {granularity:'grapheme'}).segment(value)[Symbol.iterator]().next(); return part.done ? '' : part.value.segment;}
  return Array.from(value)[0];
}
let sheetOpened = 0, press = null, scrollQueued = false, mediaClick = null;
function cancelPress() {
  if(!press) return;
  clearTimeout(press.timer);
  if(press.swipe) press.bubble.style.transform = '';
  press = null;
}

// keep=true — поставить выбранный смайл, даже если он уже стоит (иначе повторное нажатие снимает реакцию).
async function react(id, emoji, keep) {
  const message = messageById(id); if(!message || message.deleted) return;
  const mine = (message.reactions || {})[state.user.id];
  try {mergeMessages([(await post('react', {id, emoji:mine === emoji && !keep ? null : emoji})).message], 'changed');}
  catch(error) {toast(problem(error));}
}
async function removeMessage(id) {
  const before = messageById(id), file = before && before.file;
  try {
    mergeMessages([(await post('delete', {id})).message], 'changed');
    // Вместе с сообщением стираем и сам файл из хранилища.
    if(file) {stopVoice();stopVideo();if(before.kind==='video'){forgetVideo(file);window.MayakCloud.videoRemove(file).catch(()=>{});}else{forgetMedia(file);window.MayakCloud.removeFile(file).catch(() => {});}}
  } catch(error) {toast(problem(error));}
}
function jumpTo(id) {
  const row = $('messages').querySelector('[data-id="' + id + '"]');
  if(!row) {toast('Это сообщение выше. Нажмите «Показать предыдущие сообщения».'); return;}
  row.scrollIntoView({block:'center', behavior:'smooth'});
  row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1400);
}
export function closeSheet() {hideMessageMenu();}
const ICONS = {reply:'m9 5-7 7 7 7M2 12h12a7 7 0 0 1 7 7',copy:'M8 8h13v13H8zM16 8V3H3v13h5',edit:'m4 16-1 5 5-1L21 7l-4-4ZM14 6l4 4',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',close:'m6 6 12 12M6 18 18 6'};
function menuAction(label, action, icon, danger = false) {
  const item = button('', action, 'sheet-action' + (danger ? ' danger' : ''));
  item.appendChild(element('span', '', label));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS(svg.namespaceURI, 'path');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); path.setAttribute('d', ICONS[icon]); svg.appendChild(path); item.appendChild(svg);
  return item;
}
// Палитра раскрывается над выбранным сообщением, без перехода в отдельное окно.
function emojiSheet(id) {
  const message = messageById(id);
  if(!message || message.deleted) {closeSheet(); return;}
  const picker = element('div', 'sheet-picker sheet-panel'), mine = (message.reactions || {})[state.user.id];
  const heading = element('div', 'sheet-picker-heading');
  heading.append(element('span', '', 'Реакции'), button('⌃', () => openSheet(id, true), 'sheet-collapse'));
  heading.lastChild.setAttribute('aria-label', 'Свернуть реакции'); picker.appendChild(heading);
  const grid = element('div', 'emoji-grid');
  QUICK.concat(MORE).forEach(emoji => {const item = button(emoji, () => {closeSheet(); react(id, emoji);}, 'sheet-emoji' + (mine === emoji ? ' mine' : '')); item.setAttribute('aria-label', 'Реакция ' + emoji); grid.appendChild(item);});
  picker.appendChild(grid);
  const form = element('form', 'emoji-own');
  const input = element('input'); input.maxLength = 16; input.placeholder = 'Свой смайл с клавиатуры'; input.setAttribute('aria-label', 'Свой смайл'); input.autocomplete = 'off';
  const send = element('button', 'emoji-own-send', 'Поставить'); send.type = 'submit';
  form.appendChild(input); form.appendChild(send);
  form.addEventListener('submit', event => {event.preventDefault(); const emoji = firstSymbol(input.value); if(!emoji) return; closeSheet(); react(id, emoji, true);});
  picker.appendChild(form);
  setMessageMenuPanels(picker, null, true);
  sheetOpened = Date.now();
}
function openSheet(id, reuse = false) {
  const message = messageById(id);
  if(!state.user || !message || message.deleted) return;
  const row = $('messages').querySelector('[data-id="' + id + '"]'); if(!row) return;
  const user = state.user, room = state.room;
  if(!reuse) showMessageMenu(row, () => state.user === user && state.room === room && !!messageById(id) && !messageById(id).deleted, closeSheet);
  const mine = (message.reactions || {})[state.user.id];
  const reactions = element('div', 'sheet-reactions sheet-panel');
  QUICK.forEach(emoji => {const item = button(emoji, () => {closeSheet(); react(id, emoji);}, 'sheet-emoji' + (mine === emoji ? ' mine' : '')); item.setAttribute('aria-label', 'Реакция ' + emoji); reactions.appendChild(item);});
  reactions.appendChild(button('⌄', () => emojiSheet(id), 'sheet-emoji sheet-more'));
  reactions.lastChild.setAttribute('aria-label', 'Другой смайл');
  const actions = element('div', 'sheet-actions sheet-panel');
  actions.appendChild(menuAction('Ответить', () => {closeSheet(); startReply(id);}, 'reply'));
  const kind = message.kind || 'text', plain = kind === 'text';
  if(plain || (message.file_meta || {}).caption) actions.appendChild(menuAction('Скопировать текст', () => {closeSheet(); copyText(message.text).then(() => toast('Скопировано')).catch(error => toast(error.message));}, 'copy'));
  const own = message.user_id === state.user.id;
  if(own && plain) actions.appendChild(menuAction('Изменить', () => {closeSheet(); startEdit(id);}, 'edit'));
  // Своё сообщение удаляет автор; любое в общем чате — админ. В личных чатах админских прав нет.
  if(own || (state.user.owner && roomOf(message) === MAIN)) {
    actions.appendChild(menuAction(own ? 'Удалить' : 'Удалить (админ)', () => {
      const confirmation = element('div', 'sheet-actions sheet-panel');
      confirmation.appendChild(element('p', 'sheet-question', 'Удалить сообщение у всех?'));
      confirmation.appendChild(menuAction('Удалить', () => {closeSheet(); removeMessage(id);}, 'trash', true));
      confirmation.appendChild(menuAction('Отмена', closeSheet, 'close'));
      setMessageMenuPanels(null, confirmation);
    }, 'trash', true));
  }
  actions.appendChild(menuAction('Отмена', closeSheet, 'close'));
  setMessageMenuPanels(reactions, actions);
  sheetOpened = Date.now();
  // Долгое нажатие на телефоне могло начать выделение текста — сбрасываем его.
  try {const selection = window.getSelection(); if(selection) selection.removeAllRanges();} catch(_error) {}
}

export function initActions() {
  const list = $('messages');
  const rowId = node => Number(node.closest('.message-row').dataset.id);
  $('jump-button').addEventListener('click', () => {scrollBottom(); markRead();});
  $('messages-scroll').addEventListener('scroll', () => {if(scrollQueued) return; scrollQueued = true; requestAnimationFrame(() => {scrollQueued = false; markRead();});}, {passive:true});
  $('sheet-layer').addEventListener('click', event => {if((event.target === $('sheet-layer') || event.target === $('sheet')) && Date.now() - sheetOpened > 450) closeSheet();});
  // После удержания/смахивания не запускаем медиа совместимым click от webview.
  list.addEventListener('click', event => {
    const media = event.target.closest('.video-note,.voice-play,[data-photo]');
    if(mediaClick && Date.now() > mediaClick.until) mediaClick = null;
    if(media && mediaClick && rowId(media) === mediaClick.id && event.detail !== 0) {
      mediaClick = null; event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  // Нажатие на цитату, реакцию и «⋯»; правая кнопка мыши; долгое нажатие и смахивание влево на телефоне.
  list.addEventListener('click', event => {
    const quote = event.target.closest('[data-jump]'); if(quote) {jumpTo(Number(quote.dataset.jump)); return;}
    const chip = event.target.closest('[data-react]'); if(chip) {react(rowId(chip), chip.dataset.react); return;}
    const more = event.target.closest('.message-more'); if(more) {openSheet(rowId(more)); return;}
    const speed = event.target.closest('.voice-speed'); if(speed) {nextSpeed(); return;}
    const play = event.target.closest('.voice-play'); if(play) {toggleVoice(rowId(play)).catch(error => toast(error.message)); return;}
    const photo = event.target.closest('[data-photo]'); if(photo) openViewer(Number(photo.dataset.photo));
  });
  list.addEventListener('contextmenu', event => {
    const bubble = event.target.closest('.message-bubble');
    if(!bubble || event.target.closest('a')) return;
    event.preventDefault(); openSheet(rowId(bubble));
  });
  list.addEventListener('touchstart', event => {
    const bubble = event.target.closest('.message-bubble');
    cancelPress();
    mediaClick = null; // новое касание — уже отдельное нажатие, воспроизведение снова доступно
    const control = event.target.closest('button,a');
    if(!bubble || event.touches.length !== 1 || (control && !control.matches('.video-note,.voice-play'))) return;
    const row = bubble.closest('.message-row');
    if(row.classList.contains('deleted')) return;
    const touch = event.touches[0], current = {id:Number(row.dataset.id), bubble, media:!!event.target.closest('.video-note,.voice-play,[data-photo]'), x:touch.clientX, y:touch.clientY, dx:0, fired:false, swipe:false, timer:0};
    current.timer = setTimeout(() => {if(press === current && !current.swipe) {current.fired = true; if(navigator.vibrate) navigator.vibrate(15); openSheet(current.id);}}, 450);
    press = current;
  }, {passive:true});
  list.addEventListener('touchmove', event => {
    if(!press) return;
    if(event.touches.length !== 1) {cancelPress(); return;}
    if(press.fired) {if(event.cancelable) event.preventDefault(); return;}
    const touch = event.touches[0], dx = touch.clientX - press.x, dy = touch.clientY - press.y;
    if(!press.swipe) {
      if(Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {cancelPress(); return;}
      if(Math.abs(dx) <= 10) return;
      clearTimeout(press.timer); press.swipe = true;
    }
    press.dx = Math.max(-90, Math.min(0, dx));
    press.bubble.style.transform = 'translateX(' + press.dx + 'px)';
  }, {passive:false});
  const endPress = event => {
    if(!press) return;
    const current = press; press = null; clearTimeout(current.timer);
    if(current.swipe) {
      current.bubble.style.transition = 'transform .18s'; current.bubble.style.transform = '';
      setTimeout(() => {current.bubble.style.transition = '';}, 200);
      if(event.type === 'touchend' && current.dx <= -56) startReply(current.id);
    }
    if(current.fired || current.swipe) {
      if(current.media) mediaClick = {id:current.id, until:Date.now() + 900};
    }
    if(current.fired && event.cancelable) event.preventDefault(); // не нажимать то, что под пальцем при открытии меню
  };
  list.addEventListener('touchend', endPress);
  list.addEventListener('touchcancel', endPress);
  $('viewer-layer').addEventListener('click', closeViewer);
  list.addEventListener('keydown', event => {const photo = event.target.closest('[data-photo]'); if(photo && (event.key === 'Enter' || event.key === ' ')) {event.preventDefault(); openViewer(Number(photo.dataset.photo));}});
  document.addEventListener('keydown', event => {if(event.key === 'Escape' && !$('viewer-layer').hidden) {event.stopImmediatePropagation(); closeViewer();}}, true);
  document.addEventListener('keydown', event => {if(event.key === 'Escape' && !$('sheet-layer').hidden) {event.stopImmediatePropagation(); closeSheet();}}, true);
}

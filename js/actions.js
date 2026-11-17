// Действия с сообщением: меню, реакции, удаление, переход к цитате, жесты на телефоне.
import {$, state, post, problem, toast, button, element, copyText, snippet, MAIN, roomOf} from './core.js';
import {messageById, mergeMessages, markRead} from './messages.js';
import {startReply, startEdit} from './composer.js';
import {scrollBottom} from './viewport.js';
import {openViewer, closeViewer, toggleVoice, stopVoice, forgetMedia, nextSpeed} from './media.js';

const QUICK = ['👍','❤️','😂','😮','😢','🙏'];
// Остальные смайлы — по кнопке «＋». Любой другой можно ввести с клавиатуры в поле под ними.
const MORE = ['😀','😁','😅','🤣','😊','😍','😘','🥰','😎','🤔','🙄','😏','😴','🤗','🤝','👏','🙌','💪','👌','✌️','🤞','👀','🔥','💯','✨','🎉','🎂','🌹','💐','☀️','🌙','⭐','💔','💙','💚','🧡','😭','😱','😡','🤯','🥺','😇','🤡','💩','👎','🤦','🤷','🙈','🍻','☕','🍕','🚀','✅','❌','❓','❗'];
function firstSymbol(text) {
  const value = (text || '').trim(); if(!value) return '';
  if(window.Intl && Intl.Segmenter) {const part = new Intl.Segmenter('ru', {granularity:'grapheme'}).segment(value)[Symbol.iterator]().next(); return part.done ? '' : part.value.segment;}
  return Array.from(value)[0];
}
let sheetOpened = 0, press = null, scrollQueued = false;

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
    if(file) {stopVoice(); forgetMedia(file); window.MayakCloud.removeFile(file).catch(() => {});}
  } catch(error) {toast(problem(error));}
}
function jumpTo(id) {
  const row = $('messages').querySelector('[data-id="' + id + '"]');
  if(!row) {toast('Это сообщение выше. Нажмите «Показать предыдущие сообщения».'); return;}
  row.scrollIntoView({block:'center', behavior:'smooth'});
  row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1400);
}
export function closeSheet() {$('sheet-layer').hidden = true; $('sheet').replaceChildren();}
// Второй экран меню: большой набор смайлов и поле для любого своего.
function emojiSheet(id) {
  const message = messageById(id);
  if(!message || message.deleted) {closeSheet(); return;}
  const sheet = $('sheet'), mine = (message.reactions || {})[state.user.id];
  sheet.replaceChildren();
  const grid = element('div', 'emoji-grid');
  QUICK.concat(MORE).forEach(emoji => {const item = button(emoji, () => {closeSheet(); react(id, emoji);}, 'sheet-emoji' + (mine === emoji ? ' mine' : '')); item.setAttribute('aria-label', 'Реакция ' + emoji); grid.appendChild(item);});
  sheet.appendChild(grid);
  const form = element('form', 'emoji-own');
  const input = element('input'); input.maxLength = 16; input.placeholder = 'Свой смайл с клавиатуры'; input.setAttribute('aria-label', 'Свой смайл'); input.autocomplete = 'off';
  const send = element('button', 'emoji-own-send', 'Поставить'); send.type = 'submit';
  form.appendChild(input); form.appendChild(send);
  form.addEventListener('submit', event => {event.preventDefault(); const emoji = firstSymbol(input.value); if(!emoji) return; closeSheet(); react(id, emoji, true);});
  sheet.appendChild(form);
  sheet.appendChild(button('Отмена', closeSheet, 'sheet-action quiet'));
  sheetOpened = Date.now();
}
function openSheet(id) {
  const message = messageById(id);
  if(!state.user || !message || message.deleted) return;
  const sheet = $('sheet'), mine = (message.reactions || {})[state.user.id];
  sheet.replaceChildren();
  const reactions = element('div', 'sheet-reactions');
  QUICK.forEach(emoji => {const item = button(emoji, () => {closeSheet(); react(id, emoji);}, 'sheet-emoji' + (mine === emoji ? ' mine' : '')); item.setAttribute('aria-label', 'Реакция ' + emoji); reactions.appendChild(item);});
  reactions.appendChild(button('＋', () => emojiSheet(id), 'sheet-emoji sheet-more'));
  reactions.lastChild.setAttribute('aria-label', 'Другой смайл');
  sheet.appendChild(reactions);
  sheet.appendChild(element('p', 'sheet-preview', message.name + ': ' + snippet(message.text)));
  sheet.appendChild(button('Ответить', () => {closeSheet(); startReply(id);}, 'sheet-action'));
  const kind = message.kind || 'text', plain = kind === 'text';
  if(plain || (message.file_meta || {}).caption) sheet.appendChild(button('Скопировать текст', () => {closeSheet(); copyText(message.text).then(() => toast('Скопировано')).catch(error => toast(error.message));}, 'sheet-action'));
  const own = message.user_id === state.user.id;
  if(own && plain) sheet.appendChild(button('Изменить', () => {closeSheet(); startEdit(id);}, 'sheet-action'));
  // Своё сообщение удаляет автор; любое в общем чате — админ. В личных чатах админских прав нет.
  if(own || (state.user.owner && roomOf(message) === MAIN)) {
    sheet.appendChild(button(own ? 'Удалить' : 'Удалить (админ)', () => {
      sheet.replaceChildren(element('p', 'sheet-question', 'Удалить сообщение у всех?'));
      sheet.appendChild(button('Удалить', () => {closeSheet(); removeMessage(id);}, 'sheet-action danger'));
      sheet.appendChild(button('Отмена', closeSheet, 'sheet-action quiet'));
    }, 'sheet-action danger'));
  }
  sheet.appendChild(button('Отмена', closeSheet, 'sheet-action quiet'));
  sheetOpened = Date.now(); $('sheet-layer').hidden = false;
  // Долгое нажатие на телефоне могло начать выделение текста — сбрасываем его.
  try {const selection = window.getSelection(); if(selection) selection.removeAllRanges();} catch(_error) {}
}

export function initActions() {
  const list = $('messages');
  const rowId = node => Number(node.closest('.message-row').dataset.id);
  $('jump-button').addEventListener('click', () => {scrollBottom(); markRead();});
  $('messages-scroll').addEventListener('scroll', () => {if(scrollQueued) return; scrollQueued = true; requestAnimationFrame(() => {scrollQueued = false; markRead();});}, {passive:true});
  $('sheet-layer').addEventListener('click', event => {if(event.target === $('sheet-layer') && Date.now() - sheetOpened > 450) closeSheet();});
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
    press = null;
    if(!bubble || event.touches.length !== 1 || event.target.closest('button,a')) return;
    const row = bubble.closest('.message-row');
    if(row.classList.contains('deleted')) return;
    const touch = event.touches[0], current = {id:Number(row.dataset.id), bubble, x:touch.clientX, y:touch.clientY, dx:0, fired:false, swipe:false, timer:0};
    current.timer = setTimeout(() => {if(press === current && !current.swipe) {current.fired = true; if(navigator.vibrate) navigator.vibrate(15); openSheet(current.id);}}, 450);
    press = current;
  }, {passive:true});
  list.addEventListener('touchmove', event => {
    if(!press || press.fired) return;
    const touch = event.touches[0], dx = touch.clientX - press.x, dy = touch.clientY - press.y;
    if(!press.swipe) {
      if(Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {clearTimeout(press.timer); press = null; return;}
      if(Math.abs(dx) <= 10) return;
      clearTimeout(press.timer); press.swipe = true;
    }
    press.dx = Math.max(-90, Math.min(0, dx));
    press.bubble.style.transform = 'translateX(' + press.dx + 'px)';
  }, {passive:true});
  const endPress = event => {
    if(!press) return;
    const current = press; press = null; clearTimeout(current.timer);
    if(current.swipe) {
      current.bubble.style.transition = 'transform .18s'; current.bubble.style.transform = '';
      setTimeout(() => {current.bubble.style.transition = '';}, 200);
      if(event.type === 'touchend' && current.dx <= -56) startReply(current.id);
    }
    if(current.fired && event.cancelable) event.preventDefault(); // палец ещё на экране: не нажимать то, что под ним
  };
  list.addEventListener('touchend', endPress);
  list.addEventListener('touchcancel', endPress);
  $('viewer-layer').addEventListener('click', closeViewer);
  list.addEventListener('keydown', event => {const photo = event.target.closest('[data-photo]'); if(photo && (event.key === 'Enter' || event.key === ' ')) {event.preventDefault(); openViewer(Number(photo.dataset.photo));}});
  document.addEventListener('keydown', event => {if(event.key === 'Escape' && !$('viewer-layer').hidden) {event.stopImmediatePropagation(); closeViewer();}}, true);
  document.addEventListener('keydown', event => {if(event.key === 'Escape' && !$('sheet-layer').hidden) {event.stopImmediatePropagation(); closeSheet();}}, true);
}

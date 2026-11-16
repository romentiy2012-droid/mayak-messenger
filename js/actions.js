// Действия с сообщением: меню, реакции, удаление, переход к цитате, жесты на телефоне.
import {$, state, post, problem, toast, button, element, copyText, snippet} from './core.js';
import {messageById, mergeMessages, markRead} from './messages.js';
import {startReply, startEdit} from './composer.js';
import {scrollBottom} from './viewport.js';

const QUICK = ['👍','❤️','😂','😮','😢','🙏'];
let sheetOpened = 0, press = null, scrollQueued = false;

async function react(id, emoji) {
  const message = messageById(id); if(!message || message.deleted) return;
  const mine = (message.reactions || {})[state.user.id];
  try {mergeMessages([(await post('react', {id, emoji:mine === emoji ? null : emoji})).message], 'changed');}
  catch(error) {toast(problem(error));}
}
async function removeMessage(id) {
  try {mergeMessages([(await post('delete', {id})).message], 'changed');}
  catch(error) {toast(problem(error));}
}
function jumpTo(id) {
  const row = $('messages').querySelector('[data-id="' + id + '"]');
  if(!row) {toast('Это сообщение выше. Нажмите «Показать предыдущие сообщения».'); return;}
  row.scrollIntoView({block:'center', behavior:'smooth'});
  row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1400);
}
export function closeSheet() {$('sheet-layer').hidden = true; $('sheet').replaceChildren();}
function openSheet(id) {
  const message = messageById(id);
  if(!state.user || !message || message.deleted) return;
  const sheet = $('sheet'), mine = (message.reactions || {})[state.user.id];
  sheet.replaceChildren();
  const reactions = element('div', 'sheet-reactions');
  QUICK.forEach(emoji => {const item = button(emoji, () => {closeSheet(); react(id, emoji);}, 'sheet-emoji' + (mine === emoji ? ' mine' : '')); item.setAttribute('aria-label', 'Реакция ' + emoji); reactions.appendChild(item);});
  sheet.appendChild(reactions);
  sheet.appendChild(element('p', 'sheet-preview', message.name + ': ' + snippet(message.text)));
  sheet.appendChild(button('Ответить', () => {closeSheet(); startReply(id);}, 'sheet-action'));
  sheet.appendChild(button('Скопировать текст', () => {closeSheet(); copyText(message.text).then(() => toast('Скопировано')).catch(error => toast(error.message));}, 'sheet-action'));
  if(message.user_id === state.user.id) {
    sheet.appendChild(button('Изменить', () => {closeSheet(); startEdit(id);}, 'sheet-action'));
    sheet.appendChild(button('Удалить', () => {
      sheet.replaceChildren(element('p', 'sheet-question', 'Удалить сообщение у всех?'));
      sheet.appendChild(button('Удалить', () => {closeSheet(); removeMessage(id);}, 'sheet-action danger'));
      sheet.appendChild(button('Отмена', closeSheet, 'sheet-action quiet'));
    }, 'sheet-action danger'));
  }
  sheet.appendChild(button('Отмена', closeSheet, 'sheet-action quiet'));
  sheetOpened = Date.now(); $('sheet-layer').hidden = false;
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
    const more = event.target.closest('.message-more'); if(more) openSheet(rowId(more));
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
  document.addEventListener('keydown', event => {if(event.key === 'Escape' && !$('sheet-layer').hidden) {event.stopImmediatePropagation(); closeSheet();}}, true);
}

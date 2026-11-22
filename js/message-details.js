// Участники реакций и чтения: используем только уже доступные клиенту данные чата.
import {$, state, roomOf, element, button, avatar} from './core.js';
import {adjustViewport} from './viewport.js';

function person(id) {
  return state.people.find(item => item.id === id) || (state.user?.id === id ? state.user : {id, name:'Участник вышел из чата'});
}
export function reactionPeople(message) {
  if(!state.user || !message || message.deleted || message.kind === 'system') return [];
  const pair = message.peer_a ? [message.peer_a, message.peer_b] : null;
  if(pair && !pair.includes(state.user.id)) return [];
  return Object.entries(message.reactions || {}).filter(([id, emoji]) => typeof emoji === 'string' && emoji.trim() && (!pair || pair.includes(id)))
    .map(([id, emoji]) => ({...person(id), emoji}));
}
export function messageReaders(message) {
  if(!state.user || !message || message.user_id !== state.user.id || message.deleted || message.kind === 'system') return [];
  if(!message.peer_a) return state.people.filter(item => item.id !== state.user.id && Number(item.last_read) >= Number(message.id));
  const pair = [message.peer_a, message.peer_b];
  if(!pair.includes(state.user.id)) return [];
  const peer = pair.find(id => id !== state.user.id);
  const read = state.reads.find(item => item.user_id === peer && item.peer === state.user.id);
  return peer && Number(read?.last_read) >= Number(message.id) ? [person(peer)] : [];
}

let active = null;
const controls = node => [...node.querySelectorAll('button')].filter(item => !item.disabled && item.getClientRects().length);
function keyboard(event) {
  if(!active) return;
  if(event.key === 'Escape') {event.preventDefault(); event.stopImmediatePropagation(); closeMessageDetails();}
  if(event.key !== 'Tab') return;
  const items = controls(active.card), index = items.indexOf(document.activeElement);
  event.preventDefault();
  items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus({preventScroll:true});
}
export function closeMessageDetails(restoreFocus = true) {
  if(!active) return;
  const previous = active; active = null;
  document.removeEventListener('keydown', keyboard, true);
  previous.layer.remove();
  $('chat').inert = previous.inert;
  if(previous.ariaHidden === null) $('chat').removeAttribute('aria-hidden'); else $('chat').setAttribute('aria-hidden', previous.ariaHidden);
  if(!restoreFocus) return;
  let target = previous.focus;
  if(!target?.isConnected) {
    const row = [...$('messages').querySelectorAll('.message-row')].find(node => Number(node.dataset.id) === previous.id);
    target = previous.mode === 'readers' ? row?.querySelector('[data-readers]') : [...(row?.querySelectorAll('[data-react]') || [])].find(node => node.dataset.react === previous.filter);
    target ||= row?.querySelector('.message-more') || $('messages-scroll');
  }
  if(target?.isConnected && !target.closest('[hidden],[inert]')) target.focus({preventScroll:true});
}
export function refreshMessageDetails() {
  if(!active) return;
  const current = active, message = state.messages.find(item => item.id === current.id);
  if(state.user?.id !== current.user || state.room !== current.room || !message || message.deleted || roomOf(message) !== current.room || (current.mode === 'readers' && message.user_id !== current.user)) {
    closeMessageDetails(state.user?.id === current.user && state.room === current.room); return;
  }
  const all = current.mode === 'readers' ? messageReaders(message) : reactionPeople(message);
  const groups = new Map();
  if(current.mode === 'reactions') all.forEach(item => groups.set(item.emoji, (groups.get(item.emoji) || 0) + 1));
  if(current.filter && !groups.has(current.filter)) current.filter = '';
  const signature = JSON.stringify([current.filter, state.online, all.map(item => [item.id, item.name, item.emoji, item.avatar_file, item.avatar_icon])]);
  if(signature === current.signature) return;
  current.signature = signature;
  const focusedFilter = current.tabs.contains(document.activeElement) ? document.activeElement.dataset.infoFilter : null;
  current.tabs.replaceChildren();
  if(current.mode === 'reactions') {
    const add = (emoji, text) => {
      const tab = button(text, () => {current.filter = emoji; refreshMessageDetails();}, 'message-info-filter');
      tab.dataset.infoFilter = emoji; tab.setAttribute('aria-pressed', String(emoji === current.filter));
      tab.setAttribute('aria-label', emoji ? 'Показать реакцию ' + emoji + ': ' + groups.get(emoji) : 'Все реакции: ' + all.length);
      current.tabs.appendChild(tab);
    };
    add('', 'Все · ' + all.length); groups.forEach((count, emoji) => add(emoji, emoji + ' ' + count));
  }
  const shown = current.filter ? all.filter(item => item.emoji === current.filter) : all;
  current.list.replaceChildren();
  shown.forEach(item => {
    const row = element('div', 'message-info-person'); row.setAttribute('role', 'listitem');
    row.appendChild(avatar(item));
    row.appendChild(element('span', 'message-info-name', item.name + (item.id === current.user ? ' · вы' : '')));
    if(item.emoji) row.appendChild(element('span', 'message-info-emoji', item.emoji));
    current.list.appendChild(row);
  });
  current.empty.hidden = shown.length > 0;
  current.empty.textContent = current.mode === 'readers' ? 'Пока никто не прочитал' : 'Реакций пока нет';
  current.summary.textContent = current.mode === 'readers' ? 'Прочитали: ' + all.length : 'Участников: ' + shown.length;
  current.note.textContent = !state.online ? 'Нет связи. Показаны последние полученные данные.' : current.mode === 'readers' ? 'По отметкам чтения участников в этом чате.' : 'Изменить свою реакцию можно через меню сообщения.';
  if(focusedFilter !== null) ([...current.tabs.children].find(node => node.dataset.infoFilter === focusedFilter) || current.close).focus({preventScroll:true});
}
export function openMessageDetails(id, mode = 'reactions', filter = '', trigger = null) {
  const message = state.messages.find(item => item.id === id);
  if(!state.user || !message || message.deleted || message.kind === 'system' || roomOf(message) !== state.room || !['reactions','readers'].includes(mode)) return;
  if(mode === 'readers' && message.user_id !== state.user.id) return;
  closeMessageDetails(false);
  const layer = element('div', 'message-info-layer'), card = element('section', 'message-info-card');
  layer.id = 'message-info-layer'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'message-info-title');
  const header = element('div', 'message-info-header'), title = element('h2', '', mode === 'readers' ? 'Кто прочитал' : 'Кто отреагировал');
  title.id = 'message-info-title';
  const close = button('×', () => closeMessageDetails(), 'icon-button'); close.setAttribute('aria-label', 'Закрыть список');
  header.append(title, close);
  const tabs = element('div', 'message-info-filters'), summary = element('p', 'message-info-summary'); summary.setAttribute('role', 'status');
  const list = element('div', 'message-info-list'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', mode === 'readers' ? 'Прочитавшие участники' : 'Участники реакций');
  const empty = element('p', 'message-info-empty'), note = element('p', 'message-info-note');
  card.append(header, tabs, summary, list, empty, note); layer.appendChild(card);
  active = {id, mode, filter, user:state.user.id, room:state.room, layer, card, close, tabs, summary, list, empty, note, signature:null, focus:trigger || document.activeElement, inert:$('chat').inert, ariaHidden:$('chat').getAttribute('aria-hidden')};
  layer.addEventListener('click', event => {if(event.target === layer) closeMessageDetails();});
  document.body.appendChild(layer); adjustViewport(); refreshMessageDetails();
  close.focus({preventScroll:true}); $('chat').inert = true; $('chat').setAttribute('aria-hidden', 'true');
  document.addEventListener('keydown', keyboard, true);
}

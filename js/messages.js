// Лента сообщений, список участников, «прочитано», «печатает» и счётчик непрочитанных.
import {$, state, post, element, avatar, adminTag, snippet} from './core.js';
import {scrollBottom, nearBottom} from './viewport.js';
import {ping} from './sound.js';
import {renderContext} from './composer.js';

const typing = new Map();
let readTimer = null;

export function messageById(id) {return state.messages.find(message => message.id === id);}
function readByOthers(id) {return state.people.some(person => person.id !== state.user.id && Number(person.last_read) >= id);}

export function connection(online) {
  state.online = online;
  const active = state.people.filter(person => person.online).length;
  const writers = state.people.filter(person => typing.has(person.id)).map(person => person.name);
  const idle = online ? (state.user ? active + ' в сети · облачный чат' : 'Облако на связи') : 'Нет соединения';
  [$('welcome-network'), $('connection-status')].forEach(node => {
    const busy = online && writers.length && node.id === 'connection-status';
    node.classList.toggle('disconnected', !online); node.classList.toggle('typing', !!busy); node.replaceChildren(element('i'));
    node.appendChild(document.createTextNode(busy ? writers.join(', ') + (writers.length > 1 ? ' печатают…' : ' печатает…') : idle));
  });
  $('offline-banner').hidden = online || !state.user;
}
export function setTyping(id, on) {
  clearTimeout(typing.get(id));
  if(on) typing.set(id, setTimeout(() => setTyping(id, false), 6000));
  else if(!typing.delete(id)) return;
  connection(state.online);
}
export function clearTyping() {typing.forEach(item => clearTimeout(item)); typing.clear();}

function showDate(value) {
  const date = new Date(value), now = new Date();
  if(date.toDateString() === now.toDateString()) return 'Сегодня';
  const yesterday = new Date(); yesterday.setDate(now.getDate() - 1);
  if(date.toDateString() === yesterday.toDateString()) return 'Вчера';
  return date.toLocaleDateString('ru-RU', {day:'numeric', month:'long', year:date.getFullYear() === now.getFullYear() ? undefined : 'numeric'});
}
function textWithLinks(node, text) {
  const pattern = /https?:\/\/[^\s<>]+/g;
  let match, last = 0;
  while((match = pattern.exec(text))) {
    node.appendChild(document.createTextNode(text.slice(last, match.index)));
    const anchor = element('a', '', match[0]); anchor.href = match[0]; anchor.target = '_blank'; anchor.rel = 'noreferrer noopener';
    node.appendChild(anchor); last = match.index + match[0].length;
  }
  node.appendChild(document.createTextNode(text.slice(last)));
}

// Лента обновляется по частям: строка сообщения пересоздаётся, только если изменилось то, что в ней видно.
// Остальные остаются на месте, поэтому жест или выделение на них не прерывается.
const rows = new Map(), dividers = new Map();
export function resetList() {rows.clear(); dividers.clear(); $('messages').replaceChildren();}
function isOwner(id) {return !!id && state.people.some(person => person.id === id && person.owner);}
function buildRow(message, source, read, admin) {
  const own = message.user_id === state.user.id, gone = !!message.deleted;
  const row = element('article', 'message-row' + (own ? ' own' : '') + (gone ? ' deleted' : '')); row.dataset.id = message.id;
  row.appendChild(avatar({id:message.user_id, name:message.name}));
  const bubble = element('div', 'message-bubble');
  const author = element('div', 'message-author', message.name); if(admin) author.appendChild(adminTag());
  bubble.appendChild(author);
  if(!gone && message.reply_to) {
    const quote = element('button', 'message-quote'); quote.type = 'button'; quote.dataset.jump = message.reply_to;
    quote.appendChild(element('strong', '', source ? source.name : 'Сообщение'));
    quote.appendChild(element('span', '', source ? (source.deleted ? 'Сообщение удалено' : snippet(source.text)) : 'Более раннее сообщение'));
    bubble.appendChild(quote);
  }
  const text = element('div', 'message-text');
  if(gone) text.textContent = 'Сообщение удалено'; else textWithLinks(text, message.text);
  bubble.appendChild(text);
  const groups = new Map();
  if(!gone) Object.entries(message.reactions || {}).forEach(([user, emoji]) => {const group = groups.get(emoji) || {count:0, mine:false}; group.count++; if(user === state.user.id) group.mine = true; groups.set(emoji, group);});
  if(groups.size) {
    const bar = element('div', 'message-reactions');
    groups.forEach((group, emoji) => {const chip = element('button', 'reaction' + (group.mine ? ' mine' : ''), emoji + (group.count > 1 ? ' ' + group.count : '')); chip.type = 'button'; chip.dataset.react = emoji; chip.setAttribute('aria-label', 'Реакция ' + emoji + (group.mine ? ', ваша' : '')); bar.appendChild(chip);});
    bubble.appendChild(bar);
  }
  const stamp = element('div', 'message-meta');
  if(message.edited && !gone) stamp.appendChild(element('span', 'edited-mark', 'изменено'));
  const time = element('time', '', new Date(message.created).toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'}));
  time.dateTime = message.created; stamp.appendChild(time);
  if(own && !gone) {const tick = element('span', 'delivery-tick' + (read ? ' read' : ''), read ? '✓✓' : '✓'); tick.title = read ? 'Прочитано' : 'Отправлено'; stamp.appendChild(tick);}
  bubble.appendChild(stamp); row.appendChild(bubble);
  if(!gone) {const more = element('button', 'message-more', '⋯'); more.type = 'button'; more.setAttribute('aria-label', 'Действия с сообщением'); row.appendChild(more);}
  return row;
}
export function renderMessages(mode) {
  const scroll = $('messages-scroll'), list = $('messages');
  const previousHeight = scroll.scrollHeight, previousTop = scroll.scrollTop;
  const atBottom = previousHeight - previousTop - scroll.clientHeight < 130;
  const byId = new Map(state.messages.map(message => [message.id, message]));
  const wanted = [], days = new Set(); let day = '';
  state.messages.forEach(message => {
    const messageDay = new Date(message.created).toDateString();
    if(messageDay !== day) {
      day = messageDay;
      const label = showDate(message.created), key = messageDay + '|' + label;
      let divider = dividers.get(key);
      if(!divider) {divider = element('div', 'day-divider'); divider.appendChild(element('span', '', label)); dividers.set(key, divider);}
      days.add(key); wanted.push(divider);
    }
    const source = message.reply_to ? byId.get(message.reply_to) : null;
    const read = message.user_id === state.user.id && !message.deleted && readByOthers(message.id);
    const admin = isOwner(message.user_id);
    const signature = [message.rev || 0, message.name, read ? 1 : 0, source ? (source.rev || 0) + ':' + source.name : '-', state.user.id, admin ? 1 : 0, state.user.owner ? 1 : 0].join('|');
    let entry = rows.get(message.id);
    if(!entry || entry.signature !== signature) {entry = {signature, node:buildRow(message, source, read, admin)}; rows.set(message.id, entry);}
    wanted.push(entry.node);
  });
  rows.forEach((_entry, id) => {if(!byId.has(id)) rows.delete(id);});
  dividers.forEach((_node, key) => {if(!days.has(key)) dividers.delete(key);});
  // Привести ленту к нужному порядку, трогая только то, что изменилось.
  let cursor = list.firstChild;
  wanted.forEach(node => {if(node === cursor) cursor = cursor.nextSibling; else list.insertBefore(node, cursor);});
  while(cursor) {const next = cursor.nextSibling; cursor.remove(); cursor = next;}
  $('empty-chat').hidden = state.messages.length > 0;
  $('older-button').hidden = !state.older;
  if(mode === 'older') scroll.scrollTop = previousTop + scroll.scrollHeight - previousHeight;
  else if(atBottom || mode === 'initial' || mode === 'sent') scrollBottom();
}
// Режимы: initial и new — ответ сервера на опрос (двигают отметку rev); sent и changed — результат своего действия; older — история.
export function mergeMessages(messages, mode) {
  if(!messages.length && mode !== 'initial') return;
  const known = new Map(state.messages.map(message => [message.id, message]));
  const oldest = state.messages.length ? state.messages[0].id : 0;
  let fresh = false;
  messages.forEach(message => {
    const current = known.get(message.id);
    if(current) {if((message.rev || 0) >= (current.rev || 0)) known.set(message.id, message); return;}
    if(mode === 'new' && state.older && oldest && message.id < oldest) return; // изменилось сообщение из ещё не загруженной истории
    known.set(message.id, message);
    if(mode === 'new' && message.user_id !== state.user.id) {setTyping(message.user_id, false); if(!message.deleted) fresh = true;}
  });
  state.messages = Array.from(known.values()).sort((a, b) => a.id - b.id);
  if(mode !== 'older' && state.messages.length > 500) {state.messages = state.messages.slice(-500); state.older = true;}
  if(mode === 'initial' || mode === 'new') messages.forEach(message => {state.rev = Math.max(state.rev, message.rev || 0);});
  renderMessages(mode);
  if(state.reply || state.editing) renderContext();
  if(fresh) {if(document.hidden) document.title = 'Новое сообщение · Маяк'; else ping();}
  markRead();
}

export function updateUnread() {
  const count = state.user ? state.messages.filter(message => message.id > state.readUpTo && message.user_id !== state.user.id && !message.deleted).length : 0;
  $('jump-button').hidden = !state.user || nearBottom();
  $('jump-count').hidden = !count; $('jump-count').textContent = count > 99 ? '99+' : String(count);
  try {
    if(count && navigator.setAppBadge) navigator.setAppBadge(count).catch(() => {});
    else if(!count && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  } catch(_error) {}
}
// Прочитанным считается всё, что на экране: чат открыт и лента прокручена вниз.
export function markRead() {
  if(state.user && !document.hidden && state.messages.length && nearBottom()) {
    const last = state.messages[state.messages.length - 1].id;
    if(last > state.readUpTo) {
      state.readUpTo = last; clearTimeout(readTimer);
      readTimer = setTimeout(() => {if(state.user) post('read', {id:state.readUpTo}).catch(() => {});}, 400);
    }
  }
  updateUnread();
}

export function renderPeople() {
  $('people-count').textContent = state.people.length;
  const fragment = document.createDocumentFragment();
  state.people.forEach(person => {
    const row = element('div', 'person' + (person.online ? ' online' : '')); row.appendChild(avatar(person));
    const name = element('span', 'person-name', person.name); if(person.id === state.user.id) name.appendChild(element('small', '', 'вы')); if(person.owner) name.appendChild(adminTag());
    row.appendChild(name); fragment.appendChild(row);
  });
  $('people-list').replaceChildren(fragment); connection(state.online);
}
// Изменение участника пришло из облака: «печатает», «прочитано», имя.
export function memberChanged(row) {
  const index = state.people.findIndex(person => person.id === row.id), known = state.people[index];
  if(row.id !== state.user.id) {
    if(!row.typing) setTyping(row.id, false);
    else if(known && Date.parse(row.typing) !== Date.parse(known.typing || 0)) setTyping(row.id, true);
  }
  if(index < 0) state.people.push(row); else state.people[index] = row;
  renderPeople();
  if(row.id !== state.user.id && (!known || Number(known.last_read) !== Number(row.last_read))) renderMessages('changed');
}

// Лента сообщений, список чатов, «прочитано», «печатает», «был в сети» и счётчики непрочитанных.
import {$, state, post, element, avatar, paintAvatar, adminTag, snippet, MAIN, roomOf, roomPeer} from './core.js';
import {scrollBottom, nearBottom} from './viewport.js';
import {ping, sent} from './sound.js';
import {renderContext, saveDraft, restoreDraft, stopTyping} from './composer.js';
import {photoNode, voiceNode, stopVoice} from './media.js';

const typing = new Map(); // ключ «чат|участник» → таймер
let readTimer = null, mainName = 'Наш круг';

export function messageById(id) {return state.messages.find(message => message.id === id);}
const inRoom = room => state.messages.filter(message => roomOf(message) === room);
const personById = id => state.people.find(person => person.id === id);
const peerState = peer => state.reads.find(row => row.user_id === peer && row.peer === state.user.id);
// Прочитал ли сообщение кто-то кроме меня: в общем чате — любой участник, в личном — собеседник.
function readByOthers(message) {
  const room = roomOf(message);
  if(room === MAIN) return state.people.some(person => person.id !== state.user.id && Number(person.last_read) >= message.id);
  const row = peerState(room); return !!row && Number(row.last_read) >= message.id;
}
export function unreadIn(room) {
  const mark = state.read[room] || 0;
  return state.messages.filter(message => message.id > mark && roomOf(message) === room && message.user_id !== state.user.id && !message.deleted && message.kind !== 'system').length;
}
// «в сети» или когда был в последний раз.
export function lastSeen(person) {
  if(!person) return '';
  if(person.online) return 'в сети';
  const time = Date.parse(person.last_seen);
  if(!time) return 'не в сети';
  const date = new Date(time), now = new Date(), clock = date.toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'});
  if(date.toDateString() === now.toDateString()) return 'был(а) в сети в ' + clock;
  const yesterday = new Date(); yesterday.setDate(now.getDate() - 1);
  if(date.toDateString() === yesterday.toDateString()) return 'был(а) в сети вчера в ' + clock;
  return 'был(а) в сети ' + date.toLocaleDateString('ru-RU', {day:'numeric', month:'long', year:date.getFullYear() === now.getFullYear() ? undefined : 'numeric'});
}
export function roomTitle(room) {
  if(room === MAIN) return mainName;
  const person = personById(room); return person ? person.name : 'Личный чат';
}
export function setMainName(name) {mainName = name || 'Наш круг';}

// Строка под названием чата: связь, «печатает», а в личном чате — «в сети» / «был(а) в сети».
export function connection(online) {
  state.online = online;
  const room = state.room, active = state.people.filter(person => person.online).length;
  const writers = state.people.filter(person => typing.has(room + '|' + person.id)).map(person => person.name);
  let idle = online ? 'Облако на связи' : 'Нет соединения';
  if(online && state.user) idle = room === MAIN ? active + ' в сети · общий чат' : (lastSeen(personById(room)) || 'личный чат');
  [$('welcome-network'), $('connection-status')].forEach(node => {
    const busy = online && writers.length && node.id === 'connection-status';
    node.classList.toggle('disconnected', !online); node.classList.toggle('typing', !!busy);
    node.classList.toggle('away', online && !busy && room !== MAIN && !(personById(room) || {}).online && node.id === 'connection-status');
    node.replaceChildren(element('i'));
    node.appendChild(document.createTextNode(busy ? (room === MAIN ? writers.join(', ') + (writers.length > 1 ? ' печатают…' : ' печатает…') : 'печатает…') : idle));
  });
  $('offline-banner').hidden = online || !state.user;
}
export function setTyping(room, id, on) {
  const key = room + '|' + id;
  clearTimeout(typing.get(key));
  if(on) typing.set(key, setTimeout(() => setTyping(room, id, false), 6000));
  else if(!typing.delete(key)) return;
  connection(state.online); renderChats();
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
  // Служебная строка («Имя добавлен в чат») — по центру, как разделитель дня, без автора и действий.
  if(message.kind === 'system') {
    const note = element('div', 'system-note'); note.dataset.id = message.id; note.appendChild(element('span', '', message.text));
    return note;
  }
  const own = message.user_id === state.user.id, gone = !!message.deleted;
  const row = element('article', 'message-row' + (own ? ' own' : '') + (gone ? ' deleted' : '')); row.dataset.id = message.id;
  row.appendChild(avatar(personById(message.user_id) || {id:message.user_id, name:message.name}));
  const bubble = element('div', 'message-bubble');
  const author = element('div', 'message-author', message.name); if(admin) author.appendChild(adminTag());
  bubble.appendChild(author);
  if(!gone && message.reply_to) {
    const quote = element('button', 'message-quote'); quote.type = 'button'; quote.dataset.jump = message.reply_to;
    quote.appendChild(element('strong', '', source ? source.name : 'Сообщение'));
    quote.appendChild(element('span', '', source ? (source.deleted ? 'Сообщение удалено' : snippet(source.text)) : 'Более раннее сообщение'));
    bubble.appendChild(quote);
  }
  const kind = gone ? 'text' : (message.kind || 'text'), meta = message.file_meta || {};
  if(kind === 'photo' && message.file) bubble.appendChild(photoNode(message));
  if(kind === 'voice' && message.file) bubble.appendChild(voiceNode(message));
  // У вложения текст — запасной («📷 Фото»); показываем его, только если это подпись.
  if(kind === 'text' || (kind === 'photo' && meta.caption)) {
    const text = element('div', 'message-text');
    if(gone) text.textContent = 'Сообщение удалено'; else textWithLinks(text, message.text);
    bubble.appendChild(text);
  }
  if(kind !== 'text') row.classList.add('media');
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
  if(own && !gone && kind === 'voice' && (message.heard || []).length) stamp.appendChild(element('span', 'heard-mark', 'прослушано'));
  if(own && !gone) {const tick = element('span', 'delivery-tick' + (read ? ' read' : ''), read ? '✓✓' : '✓'); tick.title = read ? 'Прочитано' : 'Отправлено'; stamp.appendChild(tick);}
  bubble.appendChild(stamp); row.appendChild(bubble);
  if(!gone) {const more = element('button', 'message-more', '⋯'); more.type = 'button'; more.setAttribute('aria-label', 'Действия с сообщением'); row.appendChild(more);}
  return row;
}
export function renderMessages(mode) {
  const scroll = $('messages-scroll'), list = $('messages');
  const previousHeight = scroll.scrollHeight, previousTop = scroll.scrollTop;
  const atBottom = previousHeight - previousTop - scroll.clientHeight < 130;
  const shown = inRoom(state.room);
  const byId = new Map(state.messages.map(message => [message.id, message])), visible = new Set(shown.map(message => message.id));
  const wanted = [], days = new Set(); let day = '';
  shown.forEach(message => {
    const messageDay = new Date(message.created).toDateString();
    if(messageDay !== day) {
      day = messageDay;
      const label = showDate(message.created), key = messageDay + '|' + label;
      let divider = dividers.get(key);
      if(!divider) {divider = element('div', 'day-divider'); divider.appendChild(element('span', '', label)); dividers.set(key, divider);}
      days.add(key); wanted.push(divider);
    }
    const source = message.reply_to ? byId.get(message.reply_to) : null;
    const read = message.user_id === state.user.id && !message.deleted && readByOthers(message);
    const admin = isOwner(message.user_id);
    const signature = [message.rev || 0, message.name, read ? 1 : 0, source ? (source.rev || 0) + ':' + source.name : '-', state.user.id, admin ? 1 : 0, state.user.owner ? 1 : 0].join('|');
    let entry = rows.get(message.id);
    if(!entry || entry.signature !== signature) {entry = {signature, node:buildRow(message, source, read, admin)}; rows.set(message.id, entry);}
    wanted.push(entry.node);
  });
  rows.forEach((_entry, id) => {if(!visible.has(id)) rows.delete(id);});
  dividers.forEach((_node, key) => {if(!days.has(key)) dividers.delete(key);});
  // Привести ленту к нужному порядку, трогая только то, что изменилось.
  let cursor = list.firstChild;
  wanted.forEach(node => {if(node === cursor) cursor = cursor.nextSibling; else list.insertBefore(node, cursor);});
  while(cursor) {const next = cursor.nextSibling; cursor.remove(); cursor = next;}
  $('empty-chat').hidden = shown.length > 0;
  $('empty-title').textContent = state.room === MAIN ? 'Первое сообщение — за вами' : 'Личный чат';
  $('empty-text').textContent = state.room === MAIN ? 'Поздоровайтесь с друзьями. С этого начнётся ваша переписка.' : 'Эту переписку видите только вы и ' + roomTitle(state.room) + '.';
  $('thread-label').textContent = state.room === MAIN ? 'ВАШ МАЛЕНЬКИЙ КРУГ' : 'ЛИЧНЫЙ ЧАТ · ВИДИТЕ ТОЛЬКО ВЫ ДВОЕ';
  $('older-button').hidden = !state.older[state.room];
  if(mode === 'older') scroll.scrollTop = previousTop + scroll.scrollHeight - previousHeight;
  else if(atBottom || mode === 'initial' || mode === 'sent') scrollBottom();
}
// Режимы: initial и new — ответ сервера на опрос (двигают отметку rev); sent и changed — результат своего действия; older — история.
export function mergeMessages(messages, mode) {
  if(!messages.length && mode !== 'initial') return;
  const known = new Map(state.messages.map(message => [message.id, message]));
  const oldest = {}; state.messages.forEach(message => {const room = roomOf(message); if(!(room in oldest)) oldest[room] = message.id;});
  let fresh = false;
  messages.forEach(message => {
    const current = known.get(message.id), room = roomOf(message);
    if(current) {if((message.rev || 0) >= (current.rev || 0)) known.set(message.id, message); return;}
    if(mode === 'new' && state.older[room] && oldest[room] && message.id < oldest[room]) return; // изменилось сообщение из ещё не загруженной истории
    known.set(message.id, message);
    if(mode === 'new' && message.user_id !== state.user.id) {setTyping(room, message.user_id, false); if(!message.deleted && message.kind !== 'system') fresh = true;}
  });
  state.messages = Array.from(known.values()).sort((a, b) => a.id - b.id);
  // В памяти — не больше 500 сообщений на чат; более старые подгружаются кнопкой.
  if(mode !== 'older') {
    const counts = {}; state.messages.forEach(message => {const room = roomOf(message); counts[room] = (counts[room] || 0) + 1;});
    Object.keys(counts).filter(room => counts[room] > 500).forEach(room => {
      let extra = counts[room] - 500;
      state.messages = state.messages.filter(message => roomOf(message) !== room || extra-- <= 0);
      state.older[room] = true;
    });
  }
  if(mode === 'initial' || mode === 'new') messages.forEach(message => {state.rev = Math.max(state.rev, message.rev || 0);});
  renderMessages(mode);
  if(state.reply || state.editing) renderContext();
  if(mode === 'sent') sent();
  if(fresh) {if(document.hidden) document.title = 'Новое сообщение · Маяк'; else ping();}
  markRead();
}

export function updateUnread() {
  const here = state.user ? unreadIn(state.room) : 0;
  let total = 0;
  if(state.user) {total = unreadIn(MAIN); state.people.forEach(person => {if(person.id !== state.user.id) total += unreadIn(person.id);});}
  const elsewhere = total - here;
  $('jump-button').hidden = !state.user || nearBottom();
  $('jump-count').hidden = !here; $('jump-count').textContent = here > 99 ? '99+' : String(here);
  $('chats-count').hidden = !elsewhere; $('chats-count').textContent = elsewhere > 99 ? '99+' : String(elsewhere);
  try {
    if(total && navigator.setAppBadge) navigator.setAppBadge(total).catch(() => {});
    else if(!total && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  } catch(_error) {}
  renderChats();
}
// Прочитанным считается всё, что на экране: чат открыт и лента прокручена вниз.
export function markRead() {
  const room = state.room, shown = state.user ? inRoom(room) : [];
  if(state.user && !document.hidden && shown.length && nearBottom()) {
    const last = shown[shown.length - 1].id;
    if(last > (state.read[room] || 0)) {
      state.read[room] = last; clearTimeout(readTimer);
      readTimer = setTimeout(() => {if(state.user) post('read', {id:last, peer:room === MAIN ? null : room}).catch(() => {});}, 400);
    }
  }
  updateUnread();
}

// ===== Чаты =====
// Строка списка: общий чат либо участник (он же — личный чат с ним).
function chatRow(room, onPick) {
  const person = room === MAIN ? null : personById(room), mine = person && person.id === state.user.id;
  const row = element(mine ? 'div' : 'button', 'chat-row' + (room === state.room ? ' current' : '') + (person && person.online ? ' online' : ''));
  if(!mine) {row.type = 'button'; row.addEventListener('click', () => onPick(room));}
  if(person) row.appendChild(avatar(person)); else row.appendChild(element('span', 'avatar room-avatar', '#'));
  const text = element('span', 'chat-text'), name = element('span', 'chat-name', person ? person.name : mainName);
  if(mine) name.appendChild(element('small', '', 'вы'));
  if(person && person.owner) name.appendChild(adminTag());
  text.appendChild(name);
  const writing = !mine && state.people.some(other => typing.has(room + '|' + other.id));
  text.appendChild(element('span', 'chat-note' + (writing ? ' typing' : ''), writing ? 'печатает…' : person ? lastSeen(person) : 'Общий чат'));
  row.appendChild(text);
  const count = mine ? 0 : unreadIn(room);
  if(count) row.appendChild(element('span', 'chat-count', count > 99 ? '99+' : String(count)));
  return row;
}
export function chatList(onPick) {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(chatRow(MAIN, onPick));
  // Сначала собеседники, в конце — я сам.
  state.people.filter(person => person.id !== state.user.id).forEach(person => fragment.appendChild(chatRow(person.id, onPick)));
  const me = personById(state.user.id); if(me) fragment.appendChild(chatRow(me.id, onPick));
  return fragment;
}
export function renderChats() {
  if(!state.user) return;
  $('people-count').textContent = state.people.length;
  $('people-list').replaceChildren(chatList(openRoom));
}
export function renderPeople() {
  const me = state.people.find(person => person.id === state.user.id);
  if(me) {state.user = {...state.user, ...me}; $('my-name').textContent = state.user.name;}
  renderChats(); renderHeader(); connection(state.online);
  // Обновляем и уже нарисованные сообщения, не трогая ленту и играющее голосовое.
  document.querySelectorAll('.avatar[data-avatar-id]:not(.avatar-preview)').forEach(node => {
    const person = node.dataset.avatarId === state.user.id ? state.user : personById(node.dataset.avatarId);
    if(person) paintAvatar(node, person);
  });
}
function renderHeader() {
  document.querySelectorAll('.room-name').forEach(node => {node.textContent = roomTitle(state.room);});
  $('chat').classList.toggle('direct', state.room !== MAIN);
}
// Открыть чат: недописанное в прежнем сохраняется, у нового — восстанавливается.
export function openRoom(room) {
  if(!state.user || room === state.user.id) return;
  if(room !== MAIN && !personById(room)) room = MAIN;
  if(room === state.room) return;
  saveDraft(); stopTyping(); stopVoice();
  state.room = room; state.reply = null; state.editing = null;
  if(!(room in state.older)) state.older[room] = room !== MAIN && state.directFull; // история личного чата могла не уместиться в первую загрузку
  restoreDraft(); renderContext();
  rows.clear(); // у строк другой состав — собрать ленту заново
  renderHeader(); renderMessages('initial'); connection(state.online); markRead();
}
// Изменение участника пришло из облака: «печатает» в общем чате, «прочитано», имя, «в сети».
export function memberChanged(row) {
  const index = state.people.findIndex(person => person.id === row.id), known = state.people[index];
  if(row.id !== state.user.id) {
    if(!row.typing) setTyping(MAIN, row.id, false);
    else if(known && Date.parse(row.typing) !== Date.parse(known.typing || 0)) setTyping(MAIN, row.id, true);
  }
  if(index < 0) state.people.push(row); else state.people[index] = row;
  renderPeople();
  if(row.id !== state.user.id && state.room === MAIN && (!known || Number(known.last_read) !== Number(row.last_read))) renderMessages('changed');
}
// Состояние личных чатов: мои отметки «прочитано» (в том числе с другого моего устройства) и отметки собеседников.
export function readsLoaded(list) {
  const before = state.reads; state.reads = list || [];
  let changed = false;
  state.reads.forEach(row => {
    if(row.user_id === state.user.id) state.read[row.peer] = Math.max(state.read[row.peer] || 0, Number(row.last_read) || 0);
    else {const old = before.find(item => item.user_id === row.user_id && item.peer === row.peer); if(!old || Number(old.last_read) !== Number(row.last_read)) changed = true;}
  });
  return changed;
}
export function readChanged(row) {
  const index = state.reads.findIndex(item => item.user_id === row.user_id && item.peer === row.peer), known = state.reads[index];
  if(index < 0) state.reads.push(row); else state.reads[index] = row;
  if(row.user_id === state.user.id) {
    state.read[row.peer] = Math.max(state.read[row.peer] || 0, Number(row.last_read) || 0);
    updateUnread(); return;
  }
  if(!row.typing) setTyping(row.user_id, row.user_id, false);
  // Строки могло ещё не быть: собеседник впервые пишет мне лично.
  else if(!known || Date.parse(row.typing) !== Date.parse(known.typing || 0)) setTyping(row.user_id, row.user_id, true);
  if(state.room === row.user_id && (!known || Number(known.last_read) !== Number(row.last_read))) renderMessages('changed');
}

// Общее для всех модулей: состояние, доступ к облаку, мелкие помощники интерфейса.
export const $ = id => document.getElementById(id);
export const api = (path, options) => window.MayakCloud.api(path, options);
export const post = (route, body) => api(route, {method:'POST', body:JSON.stringify(body)});
export const problem = error => error && error.status ? error.message : 'Нет связи. Попробуйте ещё раз.';

const hash = new URLSearchParams(location.hash.slice(1));
export const state = {
  user:null, messages:[], people:[], rev:0, older:false, online:false,
  reply:null, editing:null, readUpTo:0, draft:null, attachment:null,
  polling:false, again:false, sending:false, inviteURL:'', install:null,
  invitation:hash.get('invite') || '', resetToken:hash.get('reset') || ''
};
export const prefs = {
  get(name, fallback) {try {const value = localStorage.getItem('mayak.' + name); return value === null ? fallback : value;} catch(_error) {return fallback;}},
  set(name, value) {try {if(value === null) localStorage.removeItem('mayak.' + name); else localStorage.setItem('mayak.' + name, value);} catch(_error) {}}
};

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if(className) node.className = className;
  if(text !== undefined) node.textContent = text;
  return node;
}
export function button(label, action, className = 'quiet-button') {
  const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node;
}
export function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0,2).map(word => Array.from(word)[0]).join('').toUpperCase();
}
export function palette(id) {
  id = String(id || ''); // у сообщений удалённого участника автора нет
  let value = 0; for(let i = 0; i < id.length; i++) value = (value + id.charCodeAt(i)) % 6;
  return 'palette-' + value;
}
// Маленькая пометка «админ» рядом с именем владельца чата.
export function adminTag() {return element('small', 'role-tag', 'админ');}
export function avatar(user) {return element('span', 'avatar ' + palette(user.id), initials(user.name));}
export function snippet(text) {const line = text.replace(/\s+/g, ' ').trim(); return line.length > 90 ? line.slice(0,90) + '…' : line;}

let toastTimer = null;
export function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {$('toast').hidden = true;}, 3500);
}
export function copyText(text) {
  if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const area = element('textarea', 'copy-fallback'); area.value = text; document.body.appendChild(area); area.select();
  const success = document.execCommand('copy'); area.remove();
  return success ? Promise.resolve() : Promise.reject(new Error('Выделите текст и скопируйте вручную.'));
}

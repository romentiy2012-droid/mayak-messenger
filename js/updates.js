// Новую оболочку сначала полностью устанавливает worker; страницу обновляем только в безопасный момент.
import {$, state, mutationsPending, toast, MAIN} from './core.js';
import {composerBusy, saveDraft} from './composer.js';
import {openRoom} from './messages.js';
import {nearBottom} from './viewport.js';
import {voicePlaying} from './media.js';

export const APP_VERSION = '2.21.1';
const RELOAD_KEY = 'mayak.update.reload', CONTEXT_KEY = 'mayak.update.context';
const CHECK_EVERY = 60000, QUIET_FOR = 3000;
let registration = null, checking = false, started = false, reloading = false;
let pending = null, retryTimer = null, composing = false, lastInput = Date.now(), lastCheck = 0;

function banner(text = '') {
  const node = $('update-banner');
  if(node) {node.textContent = text; node.hidden = !text;}
}
function safeToReload() {
  if(!$('startup').hidden) return false;
  if(document.hidden || !navigator.onLine || composing || Date.now() - lastInput < QUIET_FOR) return false;
  if(state.user && !state.online) return false;
  if(composerBusy() || mutationsPending() || voicePlaying()) return false;
  if(document.activeElement?.matches('input,textarea,select,[contenteditable=true]')) return false;
  if(document.querySelector('.video-note.loading') || [...document.querySelectorAll('video,audio')].some(node => !node.paused && !node.ended)) return false;
  if([...document.querySelectorAll('[role=dialog]')].some(node => node.getClientRects().length)) return false;
  // Пароли и незавершённый вход нельзя сохранять в черновики или терять при обновлении.
  if(!state.user && ($('join-name').value || $('join-password').value || $('join-invite').value || $('join-button').disabled || state.resetToken || state.invitation)) return false;
  return true;
}
function workerVersion(worker) {
  if(!worker) return Promise.resolve(null);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = value => {clearTimeout(timer); channel.port1.close(); resolve(value);};
    const timer = setTimeout(() => finish(null), 2500);
    channel.port1.onmessage = event => finish(event.data?.type === 'MAYAK_VERSION' && typeof event.data.version === 'string' ? event.data.version : null);
    try {worker.postMessage({type:'MAYAK_VERSION'}, [channel.port2]);} catch(_error) {finish(null);}
  });
}
async function inspectController() {
  const worker = navigator.serviceWorker.controller;
  const version = await workerVersion(worker);
  if(worker !== navigator.serviceWorker.controller || !version) return;
  if(version === APP_VERSION) {
    pending = null; clearInterval(retryTimer); retryTimer = null; banner(); return;
  }
  pending = {worker, version};
  banner('Есть обновление. Маяк обновится после завершения текущего действия.');
  if(!retryTimer) retryTimer = setInterval(applyUpdate, 1000);
  applyUpdate();
}
function applyUpdate() {
  if(!pending || reloading || !safeToReload()) return;
  if(pending.worker !== navigator.serviceWorker.controller) {inspectController(); return;}
  try {
    // Если сайт/кэш всё же вернул старый интерфейс, не запускаем бесконечные перезагрузки.
    if(sessionStorage.getItem(RELOAD_KEY) === pending.version) {
      banner('Обновление установится при следующем открытии Маяка.'); return;
    }
    if(saveDraft() === false) return;
    const scroll = $('messages-scroll');
    const anchor = [...$('messages').querySelectorAll('.message-row')].find(node => node.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top);
    sessionStorage.setItem(CONTEXT_KEY, JSON.stringify({user:state.user?.id, room:state.room, bottom:nearBottom(), anchor:anchor?.dataset.id, offset:anchor ? anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top : 0, version:pending.version}));
    sessionStorage.setItem(RELOAD_KEY, pending.version);
    if(sessionStorage.getItem(RELOAD_KEY) !== pending.version) return;
  } catch(_error) {return;} // Без сохранённого черновика и защиты от цикла не перезагружаем.
  reloading = true; clearInterval(retryTimer); banner('Обновляем Маяк…');
  location.reload();
}
export function restoreUpdateContext() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CONTEXT_KEY) || 'null');
    sessionStorage.removeItem(CONTEXT_KEY);
    if(sessionStorage.getItem(RELOAD_KEY) === APP_VERSION) sessionStorage.removeItem(RELOAD_KEY);
    if(!saved || !state.user || saved.user !== state.user.id) return;
    if(saved.room !== MAIN && state.people.some(person => person.id === saved.room)) openRoom(saved.room);
    if(!saved.bottom && saved.anchor) {
      const scroll = $('messages-scroll'), anchor = [...$('messages').querySelectorAll('.message-row')].find(node => node.dataset.id === saved.anchor);
      if(anchor) scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - (Number(saved.offset) || 0);
    }
    if(saved.version === APP_VERSION) toast('Маяк обновлён');
  } catch(_error) {}
}
export async function checkForUpdates(force = false) {
  if(!registration || checking || document.hidden || !navigator.onLine) return;
  if(!force && Date.now() - lastCheck < 15000) return;
  checking = true; lastCheck = Date.now();
  try {await registration.update(); await inspectController();} catch(_error) {} finally {checking = false;}
}
export function initUpdates() {
  if(started || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  started = true;
  const touched = () => {lastInput = Date.now();};
  ['input','change','keydown','pointerdown','focusin','focusout','scroll'].forEach(name => document.addEventListener(name, touched, {capture:true, passive:true}));
  document.addEventListener('compositionstart', () => {composing = true; touched();});
  document.addEventListener('compositionend', () => {composing = false; touched();});
  document.addEventListener('visibilitychange', () => {if(!document.hidden) {touched(); checkForUpdates();}});
  window.addEventListener('online', () => checkForUpdates(true));
  window.addEventListener('pageshow', () => {touched(); checkForUpdates();});
  navigator.serviceWorker.addEventListener('controllerchange', inspectController);
  navigator.serviceWorker.addEventListener('message', event => {if(event.source === navigator.serviceWorker.controller && event.data?.type === 'MAYAK_UPDATE_READY') inspectController();});
  navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'}).then(value => {
    registration = value;
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {if(worker.state === 'activated') inspectController();});
    });
    inspectController(); checkForUpdates(true);
  }).catch(() => {});
  setInterval(checkForUpdates, CHECK_EVERY);
}

// Подписка устройства на push-уведомления.
import {$, api, state, toast} from './core.js';

const pushKey = (window.MAYAK_CONFIG || {}).vapidPublicKey || '';
export const pushFlags = {
  get(name) {try {return localStorage.getItem('mayak.push.' + name) === '1';} catch(_error) {return false;}},
  set(name, value) {try {if(value) localStorage.setItem('mayak.push.' + name, '1'); else localStorage.removeItem('mayak.push.' + name);} catch(_error) {}}
};
export function pushSupported() {return !!pushKey && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;}
function base64Url(buffer) {let raw = ''; new Uint8Array(buffer).forEach(byte => {raw += String.fromCharCode(byte);}); return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function pushBanner() {
  $('push-banner').hidden = !(state.user && pushSupported() && Notification.permission === 'default' && !pushFlags.get('off') && !pushFlags.get('later'));
  document.dispatchEvent(new Event('mayak-banners')); // полоса установки показывается, когда эта скрыта
}
export async function pushActive() {
  if(!pushSupported() || Notification.permission !== 'granted' || pushFlags.get('off')) return false;
  const registration = await navigator.serviceWorker.ready;
  return !!(await registration.pushManager.getSubscription());
}
/* Подписывает устройство и сохраняет подписку в облаке. ask=true — только по нажатию пользователя. */
export async function pushSync(ask) {
  if(!pushSupported() || !state.user) return false;
  if(Notification.permission === 'default') {if(!ask) return false; await Notification.requestPermission();}
  if(Notification.permission !== 'granted') return false;
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const current = subscription && subscription.options && subscription.options.applicationServerKey;
  if(current && base64Url(current) !== pushKey) {await subscription.unsubscribe(); subscription = null;}
  if(!subscription) subscription = await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:Uint8Array.from(atob(pushKey.replace(/-/g,'+').replace(/_/g,'/')), char => char.charCodeAt(0))});
  const data = subscription.toJSON();
  await api('push-subscribe', {method:'POST', body:JSON.stringify({endpoint:data.endpoint, p256dh:data.keys.p256dh, auth:data.keys.auth})});
  return true;
}
export async function pushEnable() {
  pushFlags.set('off', false);
  try {
    const done = await pushSync(true);
    toast(done ? 'Уведомления включены' : 'Уведомления запрещены в настройках браузера или телефона.');
  } catch(error) {toast('Не удалось включить уведомления: ' + (error.message || 'ошибка'));}
  pushBanner();
}
export async function pushDisable(forget) {
  if(!forget) pushFlags.set('off', true);
  if(!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = registration && await registration.pushManager.getSubscription();
  if(!subscription) return;
  try {await api('push-unsubscribe', {method:'POST', body:JSON.stringify({endpoint:subscription.endpoint})});} catch(_error) {}
  await subscription.unsubscribe().catch(() => {});
}
export function clearNotifications() {
  if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then(registration => registration && registration.getNotifications ? registration.getNotifications() : []).then(list => list.forEach(item => item.close())).catch(() => {});
}

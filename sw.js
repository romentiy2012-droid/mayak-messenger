const VERSION = '2.22.5';
const CACHE = 'mayak-shell-' + VERSION + ':' + self.registration.scope;
const SHELL = ['./', './style.css', './weather.css', './js/weather.js', './js/weather-model.js', './assets/chat-nautical.png', './theme.js', './app.js', './js/core.js', './js/offline.js', './js/outbox.js', './js/avatars.js', './js/session.js', './js/messages.js', './js/composer.js', './js/actions.js', './js/message-details.js', './js/stickers.js', './js/expressions.js', './js/emoji-data.js', './js/message-menu.js', './js/dialogs.js', './js/storage.js', './js/polls.js', './js/install.js', './js/updates.js', './js/push.js', './js/viewport.js', './js/sound.js', './js/media.js', './js/photo-viewer.js', './js/voice-timing.js', './js/voice-mp4.js', './js/video.js', './cloud.js', './vendor/supabase.js', './config.js', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './manifest.webmanifest'].map(path=>new URL(path,self.registration.scope).href);
// HTTP-кэш может содержать предыдущий выпуск. Новую оболочку получаем отдельно
// и проверяем до активации, иначе старый клиент попадёт в кэш с новым номером.
async function shellResponse(path) {
  const url = new URL(path); url.searchParams.set('__mayak_release', VERSION);
  const response = await fetch(url.href, {cache:'no-store', credentials:'same-origin', redirect:'error'});
  if(!response.ok) throw Error('Не удалось загрузить оболочку: ' + path);
  return response;
}
async function installShell() {
  try {
    const cache = await caches.open(CACHE);
    // Сразу потребляем тела ответов: непрочитанные большие файлы могут занять
    // все HTTP-соединения и заблокировать загрузку остальных ресурсов.
    const results = await Promise.allSettled(SHELL.map(async path => cache.put(path, await shellResponse(path))));
    const failed = results.find(result => result.status === 'rejected');
    if(failed) throw failed.reason;
    const html = await (await cache.match(SHELL[0])).text();
    const client = await (await cache.match(new URL('./js/updates.js', self.registration.scope).href)).text();
    if(!html.includes('Маяк · только для своего круга · ' + VERSION) || !client.includes("export const APP_VERSION = '" + VERSION + "';")) throw Error('Файлы оболочки относятся к другому выпуску');
    await self.skipWaiting();
  } catch(error) {await caches.delete(CACHE); throw error;}
}
self.addEventListener('install', event => {event.waitUntil(installShell());});
self.addEventListener('activate', event => {event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('mayak-shell-') && key !== CACHE && (!key.includes(':http') || key.endsWith(':' + self.registration.scope))).map(key => caches.delete(key)))).then(() => self.clients.claim()).then(async () => {const windows = await self.clients.matchAll({type:'window'}); windows.forEach(client => client.postMessage({type:'MAYAK_UPDATE_READY', version:VERSION}));}));});
self.addEventListener('message', event => {if(event.data?.type === 'MAYAK_VERSION') event.ports[0]?.postMessage({type:'MAYAK_VERSION', version:VERSION});});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if(event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Ярлык может открыть index.html или адрес с параметрами — это та же оболочка.
  const root = new URL('./', self.registration.scope), index = new URL('./index.html', self.registration.scope);
  const path = event.request.mode === 'navigate' && (url.pathname === root.pathname || url.pathname === index.pathname) ? root.href : url.href;
  if(!SHELL.includes(path)) return;
  // Полная оболочка версии установлена атомарно; обновления приходят с новым worker.
  event.respondWith(caches.open(CACHE).then(async cache=>{
    const cached=await cache.match(path);if(cached)return cached;
    return shellResponse(path).then(response=>{cache.put(path,response.clone()).catch(()=>{});return response;});
  }));
});
// Safari/iOS отзывает подписку за push без показанного уведомления, поэтому там показываем всегда.
const ALWAYS_SHOW = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Safari\//.test(navigator.userAgent) && !/Chrom(e|ium)\//.test(navigator.userAgent));
self.addEventListener('push', event => {
  let data = {};
  try {data = event.data ? event.data.json() : {};} catch(_error) {}
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    const open = windows.some(client => client.visibilityState === 'visible' && client.url.startsWith(self.registration.scope));
    // Число непрочитанных на иконке приложения.
    try {if(Number(data.badge) > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(Number(data.badge));} catch(_error) {}
    if(open && !ALWAYS_SHOW) return;
    await self.registration.showNotification(String(data.title || 'Маяк').slice(0, 60), {
      body: String(data.body || 'Новое сообщение'), icon: new URL('./icon-192.png', self.registration.scope).href,
      tag: 'mayak-chat', renotify: true, lang: 'ru'
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if(existing) return existing.focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});

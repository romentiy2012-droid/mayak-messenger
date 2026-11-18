const CACHE = 'mayak-shell-2.13.1:' + self.registration.scope;
const SHELL = ['./', './style.css', './theme.js', './app.js', './js/core.js', './js/avatars.js', './js/session.js', './js/messages.js', './js/composer.js', './js/actions.js', './js/dialogs.js', './js/storage.js', './js/polls.js', './js/install.js', './js/push.js', './js/viewport.js', './js/sound.js', './js/media.js', './js/video.js', './cloud.js', './vendor/supabase.js', './config.js', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './manifest.webmanifest'].map(path=>new URL(path,self.registration.scope).href);
self.addEventListener('install', event => {event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));});
self.addEventListener('activate', event => {event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('mayak-shell-') && key !== CACHE && (!key.includes(':http') || key.endsWith(':' + self.registration.scope))).map(key => caches.delete(key)))).then(() => self.clients.claim()));});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if(event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if(!SHELL.includes(url.href)) return;
  // cache:'no-cache' — всегда сверяться с сервером, иначе браузер до 10 минут отдаёт старую версию.
  event.respondWith(fetch(event.request.url,{cache:'no-cache'}).then(async response=>{if(response.ok){const cache=await caches.open(CACHE);await cache.put(event.request,response.clone());}return response;}).catch(() => caches.open(CACHE).then(cache=>cache.match(event.request).then(cached => cached || (event.request.mode === 'navigate' ? cache.match(self.registration.scope) : Response.error())))));
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

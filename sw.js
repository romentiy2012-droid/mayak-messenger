const CACHE = 'mayak-shell-1.1.0:' + self.registration.scope;
const SHELL = ['./', './style.css', './app.js', './config.js', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './manifest.webmanifest'].map(path=>new URL(path,self.registration.scope).href);
self.addEventListener('install', event => {event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));});
self.addEventListener('activate', event => {event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('mayak-shell-') && key !== CACHE && (!key.includes(':http') || key.endsWith(':' + self.registration.scope))).map(key => caches.delete(key)))).then(() => self.clients.claim()));});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if(event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if(!SHELL.includes(url.href)) return;
  event.respondWith(fetch(event.request).then(async response=>{if(response.ok){const cache=await caches.open(CACHE);await cache.put(event.request,response.clone());}return response;}).catch(() => caches.open(CACHE).then(cache=>cache.match(event.request).then(cached => cached || (event.request.mode === 'navigate' ? cache.match(self.registration.scope) : Response.error())))));
});

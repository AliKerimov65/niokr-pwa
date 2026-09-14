// Service Worker: офлайн-кэш приложения
const CACHE = 'niokr-pwa-v125';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './supabase-config.js', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('supabase.co') || e.request.url.includes('supabase-js')) return;
  const isHTML = e.request.mode === 'navigate' || /\/index\.html/.test(e.request.url);
  if (isHTML) {
    // Страница приложения: сначала СЕТЬ (всегда актуальная версия), кэш — только офлайн-запас
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

// ---------- Web Push ----------
self.addEventListener('push', (e) => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){}
  e.waitUntil(self.registration.showNotification(d.title || 'НИОКР Команда', {
    body: d.body || 'Новое сообщение',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: './' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then(cs => {
    const c = cs.find(x => x.url.indexOf('niokr') > -1);
    return c ? c.focus() : clients.openWindow('./');
  }));
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

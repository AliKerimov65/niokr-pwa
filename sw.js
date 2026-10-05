// Service Worker: офлайн-кэш приложения
const CACHE = 'niokr-pwa-v167';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './supabase-config.js', './icon-192.png', './icon-512.png'];
// Минимальный размер index.html в байтах: всё меньше — «битый» ответ (заглушка, обрезок,
// страница ошибки), его нельзя кэшировать и нельзя отдавать как приложение (защита от
// «отравленного» кэша, из-за которого приложение не загружается). Реальный index.html ~790 КБ.
const MIN_HTML = 10000;

// Проверка и выброс «отравленной» копии index.html из кэша; возвращает true, если кэш исправен
function cacheValid(){
  return caches.open(CACHE).then(c => c.match('./index.html').then(r => {
    if(!r) return true; // кэша нет — нечего чинить, сеть спасёт
    const len = +(r.headers.get('content-length') || 0);
    if(len > 0 && len < MIN_HTML) return c.delete('./index.html').then(() => false);
    return r.text().then(t => {
      if(t.length < MIN_HTML) return c.delete('./index.html').then(() => false);
      return true;
    });
  })).catch(() => true);
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => cacheValid()).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('supabase.co') || e.request.url.includes('supabase-js')) return;
  const isHTML = e.request.mode === 'navigate' || /\/index\.html/.test(e.request.url);
  if (isHTML) {
    // Страница приложения: сначала СЕТЬ без HTTP-кэша (всегда актуальная версия), кэш — только офлайн-запас
    e.respondWith(
      fetch(e.request, {cache: 'no-store'}).then(res => {
        const len = +(res.headers.get('content-length') || 0);
        const bad = !res.ok || (len > 0 && len < MIN_HTML);
        if(bad){
          return caches.open(CACHE).then(c => c.delete('./index.html').then(() =>
            caches.match('./index.html').then(cached => cached || res)
          ));
        }
        // content-length может отсутствовать (gzip/chunked) — сверяем реальный размер тела
        return res.clone().text().then(t => {
          if(t.length < MIN_HTML){
            return caches.open(CACHE).then(c => c.delete('./index.html').then(() =>
              caches.match('./index.html').then(cached => cached || res)
            ));
          }
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return res;
        });
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
function idbGetPushPrefs(){
  return new Promise((res) => {
    try{
      const r = indexedDB.open('niokr-push', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => {
        try{
          const g = r.result.transaction('kv').objectStore('kv').get('prefs');
          g.onsuccess = () => res((g.result && g.result.prefs) || null);
          g.onerror = () => res(null);
        }catch(e){ res(null); }
      };
      r.onerror = () => res(null);
    }catch(e){ res(null); }
  });
}
self.addEventListener('push', (e) => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){}
  e.waitUntil((async () => {
    // Фильтр категорий: пользователь отключил этот тип уведомлений (резервный уровень; основная фильтрация — на сервере)
    if(d.kind){
      const prefs = await idbGetPushPrefs();
      if(prefs && prefs[d.kind] === false) return;
    }
    await self.registration.showNotification(d.title || 'НИОКР Команда', {
      body: d.body || 'Новое сообщение',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: d.tag || 'niokr',
      data: { url: d.url || './' }
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then(cs => {
    const c = cs.find(x => x.url.indexOf('niokr') > -1);
    if(c){ c.focus(); try{ c.navigate(url); }catch(err){} return; }
    return clients.openWindow(url);
  }));
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

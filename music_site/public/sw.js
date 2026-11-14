const CACHE = 'qgroup-music-v4';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './extra.css',
  './app.js',
  './initials.js',
  './og.png',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('qgroup-music-') && k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 接口永远走网络，不缓存
  if (!url.pathname.startsWith('/music/') || url.pathname.startsWith('/music/api/')) return;
  if (req.mode === 'navigate' || !ASSETS.some((p) => new URL(p, self.location.href).pathname === url.pathname)) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});

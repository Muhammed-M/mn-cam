// Offline shell. After the first visit the app opens straight from the phone —
// instantly, with or without signal. Each visit also refreshes the files quietly
// in the background, so updates arrive on the next visit without ever reloading
// a page someone is shooting with.
//
// Bump VERSION on each release so old caches are cleaned up.
const VERSION = '2026-11-20.3';
const CACHE = `nm-cam-${VERSION}`;
const CORE = [
  'index.html', 'styles.css',
  'js/app.js', 'js/camera.js', 'js/config.js', 'js/couple.js', 'js/store.js', 'js/uploader.js', 'js/orientation.js',
  'fonts/cormorant-500.woff2', 'fonts/cormorant-500-italic.woff2',
];
const INDEX = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('nm-cam-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // uploads go straight to the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // uploads to the Worker untouched
  if (url.pathname.endsWith('/event.json')) return;       // live switch: always from the network
  const key = req.mode === 'navigate' ? INDEX : url.origin + url.pathname;
  event.respondWith(cacheFirst(key, event));
});

async function cacheFirst(key, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  const refresh = fetch(key, { cache: 'no-cache' })
    .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
    .catch(() => null);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

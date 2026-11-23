const SHELL_CACHE = 'mangaflow-shell-v1';
const PAGE_CACHE = 'manga-pages-v1';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/js/api.js',
  '/js/store.js',
  '/js/dom.js',
  '/js/reader.js',
  '/js/app.js',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== PAGE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Offline image cache lookup for downloaded chapters
  if (url.pathname === '/api/img') {
    event.respondWith(
      caches.open(PAGE_CACHE).then((cache) =>
        cache.match(req).then((hit) => hit || fetch(req))
      )
    );
    return;
  }

  // Never cache live API JSON proxy responses in shell cache
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for SPA navigations & app shell so updates land immediately online
  // while installed Home Screen apps still launch reliably offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503 });
      })
  );
});

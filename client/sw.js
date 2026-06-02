// Digital NIL service worker — installable PWA + offline app shell.
// Strategy:
//   • /api/** and socket.io   → network-only (never cache live data or auth).
//   • navigations (HTML)       → network-first, fall back to the cached SPA shell.
//   • other static assets      → stale-while-revalidate (fast, self-updating).
// Bump CACHE to invalidate old precaches on deploy.

const CACHE = 'dnil-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;                       // never intercept writes
  const url = new URL(request.url);

  // Live data + realtime: always go to the network, don't cache.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/uploads')) {
    return; // default browser fetch
  }

  // App navigations → network-first with offline SPA fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Static assets (incl. cross-origin fonts) → stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((resp) => {
        if (resp && resp.status === 200 && (url.origin === self.location.origin)) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

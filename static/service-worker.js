const CACHE_NAME = 'aayatun-v25';

const CORE_ASSETS = [
  '/',
  '/prayer-time',
  '/static/offline.html',
  '/static/js/script.js',
  '/static/js/verse-nav.js',
  '/static/js/qcf-font.js',
  '/static/css/style.css',
  '/static/manifest.json',
  '/static/images/favicon.png',
  '/static/images/icon-192.png',
  '/static/images/icon-512.png',
];

const CACHEABLE_HOSTS = [
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.datatables.net',
];

self.addEventListener('install', (evt) => {
  console.log('[ServiceWorker] Install');
  evt.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Pre-caching app shell');
      return Promise.all(
        CORE_ASSETS.map((url) => cache.add(url).catch(() => null))
      );
    })
  );

  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  console.log('[ServiceWorker] Activate');
  evt.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) {
          console.log('[ServiceWorker] Removing old cache', key);
          return caches.delete(key);
        }
      }));
    })
  );
  self.clients.claim();
});

function isCacheable(url) {
  return url.origin === self.location.origin || CACHEABLE_HOSTS.includes(url.hostname);
}

function staleWhileRevalidate(req) {
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            cache.put(req, res.clone());
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
}

function cacheFirst(req) {
  return caches.match(req).then((cached) => {
    if (cached) {
      return cached;
    }
    return fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      return res;
    });
  });
}

self.addEventListener('fetch', (evt) => {
  const req = evt.request;
  if (req.method !== 'GET') {
    return;
  }

  const url = new URL(req.url);

  // Authenticated, per-session API responses must never be cached (and must
  // not be replayed by staleWhileRevalidate).
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return;
  }

  if (req.mode === 'navigate') {
    evt.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('/static/offline.html'))
        )
    );
    return;
  }

  if (!isCacheable(url)) {
    return;
  }

  if (url.origin === self.location.origin) {
    evt.respondWith(staleWhileRevalidate(req));
  } else {
    evt.respondWith(cacheFirst(req));
  }
});

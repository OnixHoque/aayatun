const CACHE_NAME = 'aayatun-v160';

// Prayer Time's sunrise/sunset/midnight pills use Material Symbols. The CSS
// is precached with the shell, and install then caches every font file it
// references, so the icons still render offline.
const MATERIAL_SYMBOLS_CSS =
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined&icon_names=bedtime,books_movies_and_music,date_range,wb_twilight,wb_twilight_2&display=block';

const CORE_ASSETS = [
  '/',
  '/map',
  '/quiz',
  '/prayer-time',
  '/daily-counter',
  '/static/offline.html',
  '/static/js/script.js',
  '/static/js/recent.js',
  '/static/js/share.js',
  '/static/js/reading-map.js',
  '/static/js/quiz-attend.js',
  '/static/js/quiz.js',
  '/static/css/quiz.css',
  '/static/js/verse-nav.js',
  '/static/js/qcf-font.js',
  '/static/js/mushaf-zoom.js',
  '/static/js/install.js',
  '/static/css/style.css',
  '/static/manifest.json',
  '/static/manifest-prayer.json',
  '/static/manifest-counter.json',
  '/static/images/favicon.png',
  '/static/images/apple-touch-icon.png',
  '/static/images/icon-192.png',
  '/static/images/icon-512.png',
  MATERIAL_SYMBOLS_CSS,
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
      ).then(() => precacheIconFont(cache));
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

// The Material Symbols stylesheet points at hashed .woff2 files on
// fonts.gstatic.com. Cache those too, otherwise the CSS survives offline but
// the glyphs do not.
function precacheIconFont(cache) {
  return cache.match(MATERIAL_SYMBOLS_CSS).then((res) => {
    if (!res) return null;
    return res.text().then((css) => {
      const urls = [];
      const re = /url\((https:[^)]+)\)/g;
      let match;
      while ((match = re.exec(css))) urls.push(match[1]);
      return Promise.all(urls.map((url) => cache.add(url).catch(() => null)));
    });
  }).catch(() => null);
}

// A failed fetch with nothing cached must still resolve to a Response:
// respondWith(undefined) throws "Failed to convert value to 'Response'" and
// hides the real network error behind a TypeError.
function networkError() {
  return new Response('', { status: 504, statusText: 'Offline' });
}

function offlineShell() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Offline</title><p style="font-family:sans-serif;text-align:center;padding:2rem">' +
      'You are offline and this page has not been saved yet.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
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
        .catch(() => cached || networkError());
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
    }).catch(() => networkError());
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
        .catch(
          () =>
            caches.match(req).then((cached) =>
              cached ||
              caches.match('/static/offline.html').then((offline) => offline || offlineShell())
            )
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

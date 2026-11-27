// The app service worker delegates only semantic-search assets here.
(() => {
  const assets = 'aayatun-meaning-assets-v1';
  const prefix = '/static/meaning/';

  async function load(request, cacheName, preferCache) {
    const cache = await caches.open(cacheName).catch(() => null);
    const cached = await cache?.match(request).catch(() => undefined);
    if (preferCache && cached) return cached;
    try {
      const response = await fetch(request);
      if (response.status === 200 && cache) {
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch {
      return cached || new Response('', { status: 504, statusText: 'Offline' });
    }
  }

  self.meaningSearchCache = {
    preserves: key => key === 'transformers-cache' || key === assets,
    handle(event, url, appCache) {
      if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return false;
      const file = url.pathname.slice(prefix.length);
      // Transformers.js already caches the model. Avoid keeping a second copy.
      if (file.startsWith('models/')) return true;
      const immutable = file.endsWith('.bin') || file.startsWith('vendor/');
      event.respondWith(load(event.request, immutable ? assets : appCache, immutable));
      return true;
    },
  };
})();

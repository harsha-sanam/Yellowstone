// Service Worker — caches app shell, map tiles, Wikipedia API, Wikipedia images
const CACHE_VERSION = 'yellowstone-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell-refresh-v1`;
const TILES_CACHE = `${CACHE_VERSION}-tiles`;
const WIKI_CACHE = `${CACHE_VERSION}-wiki`;
const IMG_CACHE = `${CACHE_VERSION}-images`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES).catch(err => {
        console.warn('Some shell files failed to cache:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k.startsWith('yellowstone-') && ![SHELL_CACHE, TILES_CACHE, WIKI_CACHE, IMG_CACHE].includes(k))
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim()).then(async () => {
      // Reload even older app pages that do not yet listen for update messages.
      const windows = await self.clients.matchAll({ type: 'window' });
      await Promise.allSettled(windows.map(client => client.navigate(client.url)));
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;

  // Map tiles — cache-first, then network
  if (url.includes('tile.openstreetmap.de') || url.includes('tile.openstreetmap.org')) {
    event.respondWith(cacheFirst(event.request, TILES_CACHE));
    return;
  }

  // Wikipedia REST API — cache-first, fall back to network
  if (url.includes('en.wikipedia.org/api/rest_v1/')) {
    event.respondWith(cacheFirst(event.request, WIKI_CACHE));
    return;
  }

  // Wikipedia images (upload.wikimedia.org)
  if (url.includes('upload.wikimedia.org') || url.includes('wikimedia.org')) {
    event.respondWith(cacheFirst(event.request, IMG_CACHE));
    return;
  }

  // Leaflet from CDN
  if (url.includes('unpkg.com/leaflet')) {
    event.respondWith(cacheFirst(event.request, SHELL_CACHE));
    return;
  }

  // App shell — use fresh content online and the cached copy offline
  if (new URL(url).origin === self.location.origin) {
    event.respondWith(networkFirst(event.request));
    return;
  }
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      await cache.put(request, response.clone()).catch(() => {});
      return response;
    }
    return (await cache.match(request)) || response;
  } catch (error) {
    return (await cache.match(request)) ||
      (request.mode === 'navigate' && await cache.match('./index.html')) ||
      new Response('Offline', { status: 503 });
  }
}

// Detect HTML changes even when a deployment does not change sw.js.
async function checkPageUpdate(client) {
  if (!client || new URL(client.url).origin !== self.location.origin) return;
  const cache = await caches.open(SHELL_CACHE);
  const previous = await cache.match(client.url);
  if (!previous) return;
  try {
    const response = await fetch(client.url, { cache: 'no-store' });
    if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) return;
    const updated = await response.clone().text();
    if (updated === await previous.text()) return;
    await cache.put(client.url, response);
    client.postMessage({ type: 'APP_UPDATED' });
  } catch (error) {
    // Offline: keep the current page and cached trip data.
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    // Offline + not cached — return a graceful failure
    if (request.headers.get('accept') && request.headers.get('accept').includes('image')) {
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e2e8f0"/><text x="128" y="135" font-family="sans-serif" font-size="14" fill="#94a3b8" text-anchor="middle">Offline</text></svg>',
        { headers: { 'Content-Type': 'image/svg+xml' } }
      );
    }
    return new Response('Offline', { status: 503 });
  }
}

// Listen for pre-cache message from the page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CHECK_APP_UPDATE') {
    event.waitUntil(checkPageUpdate(event.source));
    return;
  }
  if (event.data && event.data.type === 'CACHE_URLS') {
    const urls = event.data.urls;
    const cacheName = event.data.cache || TILES_CACHE;
    event.waitUntil(
      caches.open(cacheName).then(cache => {
        return Promise.allSettled(
          urls.map(url =>
            fetch(url).then(r => r.ok && cache.put(url, r)).catch(() => {})
          )
        );
      }).then(() => {
        if (event.source) {
          event.source.postMessage({ type: 'CACHE_DONE', count: urls.length });
        }
      })
    );
  }
});

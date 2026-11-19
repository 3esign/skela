// Skela — service worker. Makes the app open with no network after one visit.
// Same-origin files: answered from the cache at once and refreshed in the background, so the app
// opens instantly on a dead or crawling site connection. A new deploy shows on the next visit.
// Firebase SDK modules on gstatic are versioned and immutable: cache first.
// Nothing else is intercepted, so inference requests always go straight to the network.

const CACHE = 'skela-v5';
const SHELL = [
  './', './index.html', './styles.css', './config.js', './icon.svg', './manifest.webmanifest',
  './src/app.js', './src/redact.js', './src/rules.js', './src/router.js', './src/telemetry.js',
  './src/hybrid.js', './src/firebase.js', './src/dryrun.js', './src/samples.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then((hit) => {
        const fresh = fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
        if (!hit) return fresh;
        event.waitUntil(fresh.catch(() => {}));
        return hit;
      }),
    );
  }
});

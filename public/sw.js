/**
 * Minimal install-friendly service worker: the app shell loads offline, while
 * API calls and rendered media always go to the network untouched.
 */
const CACHE = 'motion-studio-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const cacheable =
          response.ok &&
          (request.mode === 'navigate' ||
            ['script', 'style', 'image', 'font'].includes(request.destination));
        if (cacheable) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        const shell = await caches.match('/');
        return shell ?? Response.error();
      }),
  );
});

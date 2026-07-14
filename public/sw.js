const CACHE_NAME = 'cherryagent-shell-v7';
const APP_SHELL = ['/', '/index.html', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Always fetch fresh UI / API — never serve stale voice page from cache.
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/app.js' ||
    url.pathname === '/sw.js' ||
    url.pathname === '/health' ||
    url.pathname === '/tools' ||
    url.pathname === '/approvals' ||
    url.pathname.startsWith('/planner/') ||
    url.pathname.startsWith('/voice/') ||
    url.pathname.startsWith('/chat')
  ) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html'))),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html'))),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => 'focus' in client);
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    }),
  );
});

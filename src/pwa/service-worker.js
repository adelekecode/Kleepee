// Replaced by the Vite build with this release's public app assets only.
const PRECACHE = __PRECACHE__;
const CACHE_NAME = __CACHE_NAME__;
const APP_ROUTES = /^\/(?:$|waiting\/?$|connected\/?$|expired\/?$|j\/[^/]+\/?$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  // Do not skip waiting: an update must not replace a running sharing session.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("kleepee-shell-") && key !== CACHE_NAME)
      .map((key) => caches.delete(key)),
  )));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate" && APP_ROUTES.test(url.pathname)) {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match("/index.html") || Response.error();
    }));
    return;
  }

  // Never cache API responses, join URLs, secrets, messages, or file bytes.
  if (url.search || !PRECACHE.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) =>
    await cache.match(url.pathname) || fetch(request),
  ));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appWindows = windows.filter((client) => new URL(client.url).origin === self.location.origin);
    const existing = appWindows.find((client) => new URL(client.url).pathname === "/connected") || appWindows[0];
    // Preserve existing in-memory sessions; never navigate a live client or use
    // a join link or notification-supplied URL as a navigation destination.
    if (existing) return existing.focus();
    return self.clients.openWindow("/");
  })());
});

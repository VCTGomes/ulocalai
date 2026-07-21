/* U Local AI — service worker, network-first.
   The network always gets the first shot so an edited file shows up on the
   next load; the cache is only a fallback for when the network fails (offline,
   flaky link). The app itself needs no server once loaded — the model runs
   in the browser — so the cache is what makes it work with the tab offline. */
"use strict";

const CACHE = "ulocalai-v9";

/* The shell: everything needed to boot with no network at all. */
const SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/res/icon.svg",
  "/res/icon-192.png",
  "/res/assets/css/rmf.css",
  "/res/assets/js/app.js",
  "/res/assets/js/i18n.js",
  "/res/fonts/fonts.css",
  "/res/fonts/fa/css/all.min.css",
  "/res/fonts/inter/inter-v20-latin-regular.woff2",
  "/res/fonts/inter/inter-v20-latin-500.woff2",
  "/res/fonts/inter/inter-v20-latin-600.woff2",
  "/res/fonts/inter/inter-v20-latin-700.woff2",
  "/res/fonts/roboto/roboto-mono-v23-latin-regular.woff2",
  "/res/fonts/fa/webfonts/fa-solid-900.woff2",
  "/res/fonts/fa/webfonts/fa-regular-400.woff2",
  "/res/fonts/fa/webfonts/fa-brands-400.woff2",
  "/res/fonts/fa/webfonts/fa-sparkles.woff2",
];

self.addEventListener("install", (e) => {
  // A single missing entry must not fail the whole install, so each URL is
  // fetched on its own and failures are ignored.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Local notifications only (the page calls showNotification itself — there is
   no push service). Clicking one brings the existing tab back into focus. */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const tab = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (tab) return tab.focus();
    return self.clients.openWindow("/");
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  const isNav = req.mode === "navigate";

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Only successful basic responses are worth keeping.
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      }
      // /new and /chat/<id> are client-side routes: no file exists behind them,
      // so a server with no SPA fallback answers 404. The app shell is the
      // correct response for any navigation, whatever the server said.
      if (isNav) {
        const shell = await caches.match("/index.html") || await caches.match("/");
        if (shell) return shell;
      }
      return fresh;
    } catch {
      // Offline: a navigation always resolves to the shell, never to a cached
      // copy of some other route's HTML.
      if (isNav) {
        const shell = await caches.match("/index.html") || await caches.match("/");
        if (shell) return shell;
      }
      const hit = await caches.match(req);
      if (hit) return hit;
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});

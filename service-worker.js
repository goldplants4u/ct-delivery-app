/**
 * CT Delivery App — service worker
 *
 * Job: cache the app SHELL (this app's own HTML/CSS/JS/pins) so the page
 * itself still loads with zero signal — a cold relaunch after a device
 * restart, not just staying on an already-open tab. This is deliberately
 * separate from the route plan DATA cache (localStorage, in app.js) —
 * the shell barely changes and is safe to cache aggressively; the route
 * plan changes daily and must never be served stale from here.
 *
 * CACHE_NAME must be bumped (any different string) whenever the shell
 * file list below changes, or whenever index.html's own ?v= cache-buster
 * is bumped — otherwise a returning driver could keep getting an old
 * cached shell forever. Same "bump the version string" rule as
 * index.html's ?v=, see the comment there and in PROJECT-NOTES.md.
 */
const CACHE_NAME = "ct-delivery-shell-v2026-09-24n";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css?v=2026-09-24m",
  "./app.js?v=2026-09-24n",
  "./pins.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only ever handle same-origin GET requests for our own shell files.
  // Everything else — most importantly the Apps Script route-plan fetch
  // and any submit POST — passes straight through to the network
  // untouched. That data has its own separate offline handling in
  // app.js (the localStorage route plan cache) and must always try the
  // real network first for freshness; the service worker never gets
  // involved in it.
  if (event.request.method !== "GET" || url.origin !== location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

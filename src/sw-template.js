// Service worker template. vite.config.js fills in VERSION and PRECACHE at build time.
// Strategy: every file of the app is cached on install and served from the cache first,
// so the app opens instantly even with one bar of signal at the counter.
// Requests to other hosts (map tiles, Overpass) are not touched: they go straight to the network.

const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = "regular-maxing-" + VERSION;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("regular-maxing-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      caches
        .match("./index.html", { cacheName: CACHE })
        .then((hit) => hit || fetch(request)),
    );
    return;
  }
  event.respondWith(
    caches
      .match(request, { ignoreSearch: true })
      .then((hit) => hit || fetch(request)),
  );
});

/* sw.js — cache the app shell so the recorder opens instantly / offline.
   Recordings themselves always go over the network. */
const CACHE = "recordings-v1";
const SHELL = [
  "/",
  "/library",
  "/static/style.css",
  "/static/record.js",
  "/static/library.js",
  "/manifest.webmanifest",
  "/static/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Never cache recordings, uploads or auth.
  if (url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/media/") ||
      url.pathname.startsWith("/login")) return;

  if (SHELL.includes(url.pathname)) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
  }
});

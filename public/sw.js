// Jiangtang service worker. Strategy:
//   - hashed assets (build/client/assets/**): cache-first (they're immutable).
//   - navigations + data (HTML/JSON loaders): NetworkFirst — never serve stale
//     bookings/equipment/tickets. A stale booking is worse than a slow load.
//   - the app shell: precached on install.
//
// Scope is /m/ (the PWA surface). Registered only when the path starts with /m
// (register-sw.ts) so the desktop never installs a SW. No external SW library —
// kept hand-rolled and small for solo-maintainability: mainstream, minimal
// moving parts.

const SHELL_CACHE = "jiangtang-shell-v1";
const ASSET_CACHE = "jiangtang-assets-v1";
const SHELL_URLS = ["/m/", "/m/offline"];

// NetworkFirst: try the network; on failure, fall back to cache. For navigations
// this means a transient offline shows the last shell (then the route loader
// re-fetches data on reconnect — React Router refetches via the SSE reconnect).
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const network = await fetch(request);
    // Only cache successful, same-origin GETs.
    if (network.ok && request.method === "GET") cache.put(request, network.clone());
    return network;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Navigation offline with no cache → the offline placeholder.
    if (request.mode === "navigate") return cache.match("/m/offline");
    throw new Error("offline and not cached");
  }
}

// CacheFirst for immutable hashed assets.
async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const network = await fetch(request);
  if (network.ok) cache.put(request, network.clone());
  return network;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(SHELL_URLS.map((u) => cache.add(u).catch(() => undefined)));
      self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop old shell caches on version bump.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("jiangtang-") && ![SHELL_CACHE, ASSET_CACHE].includes(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // SSE endpoint: never intercept. It's a long-lived event stream — routing it
  // through networkFirst would buffer the response into the cache indefinitely
  // (cache.put on a response that never completes) and break live updates.
  if (url.pathname === "/api/realtime") return;

  // Hashed assets: cache-first (immutable).
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Navigations + everything else under /m: network-first (no stale data).
  if (request.mode === "navigate" || url.pathname.startsWith("/m") || url.pathname.startsWith("/api")) {
    event.respondWith(networkFirst(request));
    return;
  }
  // Default: try network, fall back to cache.
  event.respondWith(networkFirst(request));
});

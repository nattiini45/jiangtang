// Jiangtang service worker. Strategy:
//   - hashed assets (build/client/assets/**): cache-first (they're immutable).
//   - navigations + data (HTML/JSON loaders): NetworkFirst — never serve stale
//     bookings/equipment/tickets. A stale booking is worse than a slow load.
//   - the app shell: precached on install.
//
// Scope is /m (the PWA surface). Registered only on /m and its subpaths
// (register-sw.ts) so the desktop never installs a SW. No external SW library —
// kept hand-rolled and small for solo-maintainability: mainstream, minimal
// moving parts.

// The shell cache holds signed-in content (SSR HTML, loader data, uploaded images, API answers),
// keyed by URL and not by person. The sign-in page empties every "jiangtang-shell-*" cache
// (app/lib/pwa/purge-caches.ts), so keep that prefix when bumping the version. Bump the version
// when old entries must not survive: activate deletes any other jiangtang-* cache. v4 adds the
// mobile parity shell pages (events/projects/notes/timesheet/…) to the install-time precache.
const SHELL_CACHE = "jiangtang-shell-v4";
const ASSET_CACHE = "jiangtang-assets-v1";
const SHELL_URLS = [
  "/m",
  "/m/",
  "/m/offline",
  "/m/rooms",
  "/m/tasks",
  "/m/tickets",
  "/m/events",
  "/m/calendar",
  "/m/projects",
  "/m/notes",
  "/m/timesheet",
  "/m/notifications",
  "/m/locations",
  "/m/inventory/stock",
  "/m/board",
  "/m/search",
];
const OFFLINE_URL = "/m/offline";
const LOGIN_PATH = "/login";

// Whether a network answer may be stored. Only a plain 200 from this origin: a redirected answer
// or one whose final URL is the sign-in page is what a signed-out fetch gets, and storing it would
// plant the login page under an /m URL. A single-fetch redirect is a 202, so it is excluded too.
function isCacheable(request, response) {
  if (request.method !== "GET") return false;
  if (response.status !== 200 || response.type !== "basic" || response.redirected) return false;
  return !isLoginUrl(response.url);
}

function isLoginUrl(url) {
  if (!url) return false;
  try {
    return new URL(url).pathname === LOGIN_PATH;
  } catch {
    return false;
  }
}

// A followed redirect that ended on the sign-in page: the session is gone.
function isSignedOutAnswer(response) {
  return response.redirected && isLoginUrl(response.url);
}

// Fetch and store the shell pages that are not cached yet. Skips whatever is not cacheable, so a
// signed-out visitor never gets the login page stored in their place.
async function precache(urls) {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    urls.map(async (url) => {
      try {
        if (await cache.match(url)) return;
        const request = new Request(new URL(url, self.location.origin));
        const response = await fetch(request, { cache: "no-cache" });
        if (isCacheable(request, response)) await cache.put(request, response);
      } catch {
        // Offline at install: the next signed-in navigation tries again.
      }
    }),
  );
}

// Same wording as mobile.offline.* in the app catalogs; the worker cannot import them. Shown when
// an offline navigation has nothing cached, e.g. right after the sign-in page cleared the caches
// (the cached /m/offline page carries the previous person's name, so it goes with them).
const OFFLINE_COPY = {
  de: {
    title: "Offline",
    body: "Keine Verbindung. Sobald du wieder online bist, wird die Seite automatisch aktualisiert.",
  },
  en: {
    title: "Offline",
    body: "No connection. The page refreshes automatically once you are back online.",
  },
};
const OFFLINE_FALLBACK_LANG = "en";

// Runs in the placeholder page, not in the worker (it is stringified into the HTML below). The
// language is chosen here because the Request a fetch event sees rarely carries Accept-Language
// (Chromium adds it below the worker). It follows the app's own order: the "locale" cookie (not
// HttpOnly), then the browser languages, then the fallback.
function offlinePageMain(copy, fallback) {
  var lang = fallback;
  var cookie = /(?:^|;\s*)locale=(de|en)\s*(?:;|$)/.exec(document.cookie || "");
  if (cookie) {
    lang = cookie[1];
  } else {
    var tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
    for (var i = 0; i < tags.length; i++) {
      var primary = String(tags[i]).toLowerCase().split(/[-_]/)[0];
      if (primary === "de" || primary === "en") {
        lang = primary;
        break;
      }
    }
  }
  document.documentElement.lang = lang;
  document.title = copy[lang].title;
  document.getElementById("offline-title").textContent = copy[lang].title;
  document.getElementById("offline-body").textContent = copy[lang].body;
}

// Keeps the page's promise to refresh once the connection is back: reloads on "online" and, when
// the page loads while the browser already reports itself online, retries with a backoff (the
// event can fire before the network works and never repeats). Same script as the app's
// /m/offline page, which the worker cannot import: app/lib/pwa/offline-reload-script.ts. Keep the
// two identical; app/lib/pwa/__tests__ runs both against the same scenarios.
const OFFLINE_RELOAD_SCRIPT =
  '(function(){var K="jt-offline-reload",MAX=8,done=0;' +
  "function go(){if(!done){done=1;location.reload()}}" +
  'window.addEventListener("online",go);' +
  'if(!navigator.onLine||location.pathname==="/m/offline")return;' +
  "try{var s=window.sessionStorage,p=(s.getItem(K)||'').split(','),n=+p[0]||0,now=Date.now();" +
  "if(now-(+p[1]||0)>600000)n=0;" +
  "if(n>=MAX)return;" +
  "var d=Math.min(5000*Math.pow(2,n),60000);" +
  "s.setItem(K,(n+1)+','+(now+d));" +
  "setTimeout(go,d)}catch(e){}})();";

// The texts are constants, but "<" is escaped anyway so they can never close the script element.
const OFFLINE_SCRIPT =
  "(" + offlinePageMain + ")(" +
  JSON.stringify(OFFLINE_COPY).split("<").join(String.fromCharCode(92) + "u003c") + "," +
  JSON.stringify(OFFLINE_FALLBACK_LANG) + ");" + OFFLINE_RELOAD_SCRIPT;

function builtInOffline() {
  const { title, body } = OFFLINE_COPY[OFFLINE_FALLBACK_LANG];
  const html =
    '<!doctype html><html lang="' + OFFLINE_FALLBACK_LANG + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + title + "</title></head>" +
    '<body style="font-family:system-ui,sans-serif;text-align:center;padding:3rem 1rem">' +
    '<h1 id="offline-title">' + title + "</h1>" +
    '<p id="offline-body">' + body + "</p>" +
    "<script>" + OFFLINE_SCRIPT + "</script></body></html>";
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// NetworkFirst: try the network; on failure, fall back to cache. For navigations
// this means a transient offline shows the last shell (then the route loader
// re-fetches data on reconnect — React Router refetches via the SSE reconnect).
async function networkFirst(request, waitUntil) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const network = await fetch(request, { cache: "no-cache" });
    if (isCacheable(request, network)) {
      waitUntil(cache.put(request, network.clone()).catch(() => undefined));
      // After the sign-in page emptied the cache, the next signed-in navigation restores the
      // offline page so a later outage still shows the app's own placeholder.
      if (request.mode === "navigate") waitUntil(precache([OFFLINE_URL]));
    } else if (isSignedOutAnswer(network)) {
      waitUntil(caches.delete(SHELL_CACHE));
    }
    return network;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Navigation offline with no cache → the offline placeholder.
    if (request.mode === "navigate") return (await cache.match(OFFLINE_URL)) || builtInOffline();
    throw new Error("offline and not cached");
  }
}

// CacheFirst for immutable hashed assets. The store happens after the answer is on its way, and a
// failed write (full quota, Vary: *) costs only the cache entry, never the asset.
async function cacheFirst(request, waitUntil) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const network = await fetch(request);
  if (isCacheable(request, network)) {
    waitUntil(cache.put(request, network.clone()).catch(() => undefined));
  }
  return network;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await precache(SHELL_URLS);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop old shell caches on version bump.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("jiangtang-") && ![SHELL_CACHE, ASSET_CACHE].includes(k))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Keeps the worker alive for the cache writes a fetch handler starts. The lifetime promise is
// registered while the event is still being dispatched, which every browser allows; the handlers
// add their writes to it after awaiting the network instead of calling event.waitUntil late,
// which an engine may refuse with InvalidStateError — inside networkFirst's try block that would
// turn a good network answer into the offline fallback. It settles once the answer is out and
// every write added before then has finished; a failed write never rejects it.
function extendLifetime(event) {
  let release;
  event.waitUntil(new Promise((resolve) => (release = resolve)));
  const writes = [];
  return {
    waitUntil: (promise) => void writes.push(Promise.resolve(promise).catch(() => undefined)),
    respondWith: (answer) => {
      event.respondWith(answer);
      Promise.resolve(answer)
        .catch(() => undefined)
        .then(() => Promise.all(writes))
        .then(() => release());
    },
  };
}

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
  const mobile = /^\/m(?:\/|$|\.data$)/.test(url.pathname);
  if (request.mode === "navigate" && !mobile) return;
  if (!mobile && !/^\/(?:assets|api|attachments)\//.test(url.pathname)) return;
  const lifetime = extendLifetime(event);
  if (url.pathname.startsWith("/assets/")) {
    lifetime.respondWith(cacheFirst(request, lifetime.waitUntil));
    return;
  }
  // Navigations + everything else under /m: network-first (no stale data).
  if (request.mode === "navigate" || mobile || url.pathname.startsWith("/api/")) {
    lifetime.respondWith(networkFirst(request, lifetime.waitUntil));
    return;
  }
  // Default: try network, fall back to cache.
  lifetime.respondWith(networkFirst(request, lifetime.waitUntil));
});

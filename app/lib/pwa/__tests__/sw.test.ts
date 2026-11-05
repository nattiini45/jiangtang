import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeSignedInCaches } from "../purge-caches";
import { mobileDe } from "~/i18n/catalog/de/mobile";
import { mobileEn } from "~/i18n/catalog/en/mobile";

const HERE = dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = readFileSync(
  resolve(join(HERE, "..", "..", "..", "..", "public", "sw.js")),
  "utf-8",
);

const ORIGIN = "https://app.test";
const abs = (u: string) => new URL(u, ORIGIN).href;

type FakeResponse = {
  status: number;
  type: string;
  redirected: boolean;
  url: string;
  body: string;
  clone: () => FakeResponse;
};

function response(url: string, body: string, init: Partial<FakeResponse> = {}): FakeResponse {
  const r: FakeResponse = {
    status: 200,
    type: "basic",
    redirected: false,
    url: abs(url),
    body,
    clone: () => ({ ...r }),
    ...init,
  };
  return r;
}

/** An in-memory CacheStorage keyed by absolute URL, enough for the worker's use. */
function createCaches() {
  const stores = new Map<string, Map<string, FakeResponse>>();
  const keyOf = (r: string | { url: string }) => abs(typeof r === "string" ? r : r.url);
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (req: { url: string }, res: FakeResponse) => void store.set(keyOf(req), res),
      match: async (req: string | { url: string }) => store.get(keyOf(req)),
    };
  };
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
}

type Handler = (event: Record<string, unknown>) => void;

function loadWorker(network: (url: string) => FakeResponse) {
  const caches = createCaches();
  const handlers: Record<string, Handler> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const online = { value: true };
  const fetchImpl = async (input: string | { url: string }) => {
    if (!online.value) throw new TypeError("network down");
    return network(abs(typeof input === "string" ? input : input.url));
  };
  vm.runInNewContext(SW_SOURCE, {
    self,
    caches,
    fetch: fetchImpl,
    URL,
    Response,
    Request,
    Headers,
    console,
  });

  async function run(type: string, extra: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    let responded: Promise<FakeResponse> | undefined;
    handlers[type]!({
      ...extra,
      respondWith: (p: Promise<FakeResponse>) => {
        responded = p;
      },
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
    });
    const result = responded ? await responded : undefined;
    await Promise.all(pending);
    return result;
  }

  return {
    caches,
    online,
    install: () => run("install"),
    activate: () => run("activate"),
    request: (path: string, opts: { mode?: string; method?: string; lang?: string } = {}) =>
      run("fetch", {
        request: {
          url: abs(path),
          method: opts.method ?? "GET",
          mode: opts.mode ?? "same-origin",
          headers: new Headers(opts.lang ? { "accept-language": opts.lang } : {}),
        },
      }),
  };
}

const cachedUrls = (w: ReturnType<typeof loadWorker>) =>
  [...(w.caches.stores.get("jiangtang-shell-v2")?.keys() ?? [])].sort();

const asStorage = (w: ReturnType<typeof loadWorker>) => w.caches as unknown as CacheStorage;

describe("service worker caching", () => {
  let signedIn: boolean;
  let worker: ReturnType<typeof loadWorker>;

  beforeEach(() => {
    signedIn = true;
    worker = loadWorker((url) => {
      const { pathname } = new URL(url);
      if (!signedIn && pathname.endsWith(".data")) {
        // A single-fetch redirect is a 202 answer, not an HTTP redirect.
        return response(pathname, "redirect payload", { status: 202 });
      }
      if (!signedIn && (pathname.startsWith("/m") || pathname.startsWith("/api"))) {
        // What a followed redirect to the sign-in page looks like to a fetch.
        return response("/login", "login page", { redirected: true });
      }
      return response(pathname, `body of ${pathname}`);
    });
  });

  it("caches a signed-in navigation and serves it when the network is down", async () => {
    await worker.request("/m/tickets", { mode: "navigate" });
    worker.online.value = false;

    const offline = await worker.request("/m/tickets", { mode: "navigate" });

    expect(offline?.body).toBe("body of /m/tickets");
  });

  it("does not cache a redirected response or a single-fetch redirect", async () => {
    signedIn = false;

    await worker.request("/m/tickets");
    await worker.request("/m/tickets.data");

    expect(cachedUrls(worker)).toEqual([]);
  });

  it("does not cache the login page even when it arrives without a redirect", async () => {
    const direct = loadWorker(() => response("/login", "login page"));

    await direct.request("/m/tickets");

    expect(cachedUrls(direct)).toEqual([]);
  });

  it("does not cache a non-200 answer", async () => {
    const odd = loadWorker((url) => response(url, "x", { status: 202 }));

    await odd.request("/m/tickets.data");

    expect(cachedUrls(odd)).toEqual([]);
  });

  it("drops the cached signed-in pages when a request is bounced to the sign-in page", async () => {
    await worker.request("/m/tickets", { mode: "navigate" });
    expect(cachedUrls(worker)).toContain(abs("/m/tickets"));
    signedIn = false;

    await worker.request("/api/tickets");

    expect(worker.caches.stores.has("jiangtang-shell-v2")).toBe(false);
  });

  it("serves a built-in placeholder offline once the caches are purged, in the visitor's language", async () => {
    await worker.request("/m/tickets", { mode: "navigate" });
    await purgeSignedInCaches(asStorage(worker));
    worker.online.value = false;

    const de = await worker.request("/m/tickets", { mode: "navigate", lang: "de-DE,de;q=0.9" });
    const en = await worker.request("/m/tickets", { mode: "navigate", lang: "en-GB" });
    const deText = await (de as unknown as Response).text();
    const enText = await (en as unknown as Response).text();

    expect(deText).toContain("Keine Verbindung");
    expect(enText).toContain("No connection");
    expect(enText).not.toContain("body of");

    // The worker cannot import the catalogs, so it carries a copy; keep the copy in step.
    for (const [text, catalog] of [
      [deText, mobileDe],
      [enText, mobileEn],
    ] as const) {
      expect(text).toContain(`<h1>${catalog["mobile.offline.title"]}</h1>`);
      expect(text).toContain(`<p>${catalog["mobile.offline.body"]}</p>`);
    }
  });

  it("re-caches the offline page on the next signed-in navigation after a purge", async () => {
    await worker.install();
    await purgeSignedInCaches(asStorage(worker));

    await worker.request("/m/", { mode: "navigate" });

    expect(cachedUrls(worker)).toContain(abs("/m/offline"));
  });

  it("precaches the shell at install, but not when signed out", async () => {
    await worker.install();
    expect(cachedUrls(worker)).toEqual([abs("/m/"), abs("/m/offline")]);

    const bounced = loadWorker(() => response("/login", "login page", { redirected: true }));
    await bounced.install();
    expect(cachedUrls(bounced)).toEqual([]);
  });

  it("removes older versioned caches on activate and keeps the current ones", async () => {
    await worker.caches.open("jiangtang-shell-v1");
    await worker.caches.open("jiangtang-shell-v2");
    await worker.caches.open("jiangtang-assets-v1");

    await worker.activate();

    expect([...worker.caches.stores.keys()].sort()).toEqual([
      "jiangtang-assets-v1",
      "jiangtang-shell-v2",
    ]);
  });

  it("leaves the asset cache out of the purge", async () => {
    await worker.request("/assets/app-abc123.js");
    await purgeSignedInCaches(asStorage(worker));

    expect(worker.caches.stores.get("jiangtang-assets-v1")?.size).toBe(1);
  });
});

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeSignedInCaches } from "../purge-caches";
import { createTab, describeOfflineReload } from "./reload-harness";
import { OFFLINE_RELOAD_SCRIPT } from "../offline-reload-script";
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

/**
 * How a cache write behaves: the default stores, "reject" fails like a full quota, "hang" never
 * settles, "gate" stores once the test releases it.
 */
type PutMode = "store" | "reject" | "hang" | "gate";

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
  const putMode = { value: "store" as PutMode };
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => void (release = resolve));
  const keyOf = (r: string | { url: string }) => abs(typeof r === "string" ? r : r.url);
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (req: { url: string }, res: FakeResponse) => {
        if (putMode.value === "reject")
          throw new DOMException("quota exceeded", "QuotaExceededError");
        if (putMode.value === "hang") return new Promise<void>(() => undefined);
        if (putMode.value === "gate") await gate;
        store.set(keyOf(req), res);
      },
      match: async (req: string | { url: string }) => store.get(keyOf(req)),
    };
  };
  return {
    stores,
    putMode,
    releasePuts: () => release(),
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
}

type OfflineEnv = { cookie: string; languages: string[] };

/** Runs the placeholder's inline script against a minimal document and reports what it did. */
function runOfflineScript(html: string, env: OfflineEnv) {
  const nodes = {
    "offline-title": { textContent: "" },
    "offline-body": { textContent: "" },
  } as Record<string, { textContent: string }>;
  const document = {
    cookie: env.cookie,
    title: "",
    documentElement: { lang: "en" },
    getElementById: (id: string) => nodes[id],
  };
  const page = createTab().load(scriptOf(html), {
    onLine: false,
    document,
    navigator: { languages: env.languages, language: env.languages[0] },
  });
  return {
    lang: document.documentElement.lang,
    title: nodes["offline-title"]!.textContent,
    body: nodes["offline-body"]!.textContent,
    page,
  };
}

function scriptOf(html: string) {
  const source = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!source) throw new Error("the placeholder has no inline script");
  return source;
}

type Handler = (event: Record<string, unknown>) => void;

function loadWorker(network: (url: string) => FakeResponse) {
  const caches = createCaches();
  const handlers: Record<string, Handler> = {};
  const lifecycle = { skipWaiting: 0, claim: 0 };
  const requests: { url: string; cache?: RequestCache }[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: () => {
      lifecycle.skipWaiting++;
    },
    clients: {
      claim: async () => {
        lifecycle.claim++;
      },
    },
  };
  const online = { value: true };
  const fetchImpl = async (input: string | { url: string }, init?: RequestInit) => {
    requests.push({ url: abs(typeof input === "string" ? input : input.url), cache: init?.cache });
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

  /**
   * Dispatches an event the way a strict engine would: waitUntil is accepted only while the
   * listener runs. The spec also allows it later while a lifetime promise is pending, but an
   * engine that refuses it there must not cost the page its network answer.
   */
  function dispatch(type: string, event: Record<string, unknown>, pending: Promise<unknown>[]) {
    let dispatching = true;
    handlers[type]!({
      ...event,
      waitUntil: (p: Promise<unknown>) => {
        if (!dispatching) throw new DOMException("event is no longer active", "InvalidStateError");
        pending.push(p);
      },
    });
    dispatching = false;
  }

  async function run(type: string, extra: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    let responded: Promise<FakeResponse> | undefined;
    dispatch(
      type,
      {
        ...extra,
        respondWith: (p: Promise<FakeResponse>) => {
          responded = p;
        },
      },
      pending,
    );
    const result = responded ? await responded : undefined;
    await Promise.all(pending);
    return result;
  }

  // The answer alone, plus every promise the worker handed to waitUntil, without waiting for them.
  function respond(path: string, opts: { mode?: string } = {}) {
    const waited: Promise<unknown>[] = [];
    let responded: Promise<FakeResponse> | undefined;
    dispatch(
      "fetch",
      {
        request: {
          url: abs(path),
          method: "GET",
          mode: opts.mode ?? "same-origin",
          headers: new Headers(),
        },
        respondWith: (p: Promise<FakeResponse>) => {
          responded = p;
        },
      },
      waited,
    );
    return { answer: responded!, waited };
  }

  return {
    lifecycle,
    requests,
    caches,
    online,
    respond,
    install: () => run("install"),
    activate: () => run("activate"),
    request: (path: string, opts: { mode?: string; method?: string } = {}) =>
      run("fetch", {
        request: {
          url: abs(path),
          method: opts.method ?? "GET",
          mode: opts.mode ?? "same-origin",
          headers: new Headers(),
        },
      }),
  };
}

const cachedUrls = (w: ReturnType<typeof loadWorker>) =>
  [...(w.caches.stores.get("jiangtang-shell-v4")?.keys() ?? [])].sort();

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

  it("does not cache or choke on an opaque redirect, which is what a signed-out navigation fetch returns", async () => {
    const opaque = loadWorker(() =>
      response("/m/tickets", "", { type: "opaqueredirect", status: 0, redirected: false, url: "" }),
    );

    const answer = await opaque.request("/m/tickets", { mode: "navigate" });

    expect(answer?.type).toBe("opaqueredirect");
    expect(cachedUrls(opaque)).toEqual([]);
  });

  it("still answers a hashed asset when the cache write fails", async () => {
    worker.caches.putMode.value = "reject";

    const asset = await worker.request("/assets/app-abc123.js");

    expect(asset?.body).toBe("body of /assets/app-abc123.js");
  });

  it("answers a hashed asset without waiting for the cache write", async () => {
    worker.caches.putMode.value = "hang";

    const { answer } = worker.respond("/assets/app-abc123.js");

    expect((await answer).body).toBe("body of /assets/app-abc123.js");
  });

  describe.each([
    ["cacheFirst (hashed asset)", "/assets/app-abc123.js"],
    ["networkFirst (data request)", "/m/tickets.data"],
  ])("%s cache write", (_name, path) => {
    const settled = (p: Promise<unknown>) =>
      Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 20))]);

    it("hands the write to waitUntil, so the worker is kept alive until it is stored", async () => {
      worker.caches.putMode.value = "gate";

      const { answer, waited } = worker.respond(path);
      const res = await answer;

      // The answer is out while the write is still pending ...
      expect(res.body).toBe(`body of ${path}`);
      expect(worker.caches.stores.get("jiangtang-assets-v1")?.size ?? 0).toBe(0);
      expect(worker.caches.stores.get("jiangtang-shell-v4")?.size ?? 0).toBe(0);
      // ... and that write is what waitUntil holds on to.
      expect(waited).toHaveLength(1);
      expect(await settled(Promise.all(waited))).toBe(false);

      worker.caches.releasePuts();
      await Promise.all(waited);

      const stored = [...worker.caches.stores.values()].some((store) => store.has(abs(path)));
      expect(stored).toBe(true);
    });

    it("keeps a failed write from rejecting what waitUntil holds", async () => {
      worker.caches.putMode.value = "reject";

      const { answer, waited } = worker.respond(path);
      await answer;

      expect(waited).toHaveLength(1);
      await expect(Promise.all(waited)).resolves.toBeDefined();
    });
  });

  it("still answers a navigation when the cache write fails", async () => {
    worker.caches.putMode.value = "reject";

    const page = await worker.request("/m/tickets", { mode: "navigate" });

    expect(page?.body).toBe("body of /m/tickets");
  });

  it("serves a cached hashed asset when the network is down", async () => {
    await worker.request("/assets/app-abc123.js");
    worker.online.value = false;

    const asset = await worker.request("/assets/app-abc123.js");

    expect(asset?.body).toBe("body of /assets/app-abc123.js");
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

    expect(worker.caches.stores.has("jiangtang-shell-v4")).toBe(false);
  });

  describe("built-in offline placeholder", () => {
    async function builtIn() {
      await worker.request("/m/tickets", { mode: "navigate" });
      await purgeSignedInCaches(asStorage(worker));
      worker.online.value = false;
      const res = (await worker.request("/m/tickets", { mode: "navigate" })) as unknown as Response;
      return { res, html: await res.text() };
    }

    it("is served offline once the caches are purged, without any cached page content", async () => {
      const { res, html } = await builtIn();

      expect(res.status).toBe(503);
      expect(html).toContain("No connection");
      expect(html).not.toContain("body of");
    });

    it("picks its language in the browser: locale cookie, then the browser languages, then English", async () => {
      const { html } = await builtIn();

      const cookieDe = runOfflineScript(html, { cookie: "a=1; locale=de", languages: ["en-GB"] });
      const cookieEn = runOfflineScript(html, { cookie: "locale=en", languages: ["de-DE"] });
      const browserDe = runOfflineScript(html, { cookie: "", languages: ["fr-FR", "de-AT", "en"] });
      const fallback = runOfflineScript(html, { cookie: "locale=fr", languages: ["fr-FR"] });

      expect(cookieDe).toMatchObject({
        lang: "de",
        title: mobileDe["mobile.offline.title"],
        body: mobileDe["mobile.offline.body"],
      });
      expect(cookieEn).toMatchObject({
        lang: "en",
        title: mobileEn["mobile.offline.title"],
        body: mobileEn["mobile.offline.body"],
      });
      expect(browserDe.lang).toBe("de");
      expect(fallback.lang).toBe("en");
    });

    it("carries the catalog wording for both languages, in step with the app", async () => {
      // The worker cannot import the catalogs, so it carries a copy; keep the copy in step.
      const { html } = await builtIn();

      for (const [lang, catalog] of [
        ["de", mobileDe],
        ["en", mobileEn],
      ] as const) {
        const page = runOfflineScript(html, { cookie: `locale=${lang}`, languages: [] });
        expect(page.title).toBe(catalog["mobile.offline.title"]);
        expect(page.body).toBe(catalog["mobile.offline.body"]);
      }
      // Without a script the static markup is already readable.
      expect(html).toContain(`<h1 id="offline-title">${mobileEn["mobile.offline.title"]}</h1>`);
      expect(html).toContain(`<p id="offline-body">${mobileEn["mobile.offline.body"]}</p>`);
    });

    it("ends with the same reload script as the app's /m/offline page", async () => {
      const { html } = await builtIn();

      expect(scriptOf(html).endsWith(OFFLINE_RELOAD_SCRIPT)).toBe(true);
    });
  });

  describeOfflineReload(
    "built-in offline placeholder",
    async () => {
      await worker.request("/m/tickets", { mode: "navigate" });
      await purgeSignedInCaches(asStorage(worker));
      worker.online.value = false;
      const res = (await worker.request("/m/tickets", { mode: "navigate" })) as unknown as Response;
      return scriptOf(await res.text());
    },
    () => ({
      document: {
        cookie: "",
        title: "",
        documentElement: { lang: "en" },
        getElementById: () => ({ textContent: "" }),
      },
      navigator: { languages: ["en"], language: "en" },
    }),
  );

  it("re-caches the offline page on the next signed-in navigation after a purge", async () => {
    await worker.install();
    await purgeSignedInCaches(asStorage(worker));

    await worker.request("/m/", { mode: "navigate" });

    expect(cachedUrls(worker)).toContain(abs("/m/offline"));
  });

  it("precaches the shell at install, but not when signed out", async () => {
    await worker.install();
    expect(cachedUrls(worker)).toEqual(
      [
        "/m",
        "/m/",
        "/m/offline",
        "/m/rooms",
        "/m/tasks",
        "/m/tickets",
        "/m/events",
        "/m/projects",
        "/m/notes",
        "/m/timesheet",
        "/m/notifications",
        "/m/locations",
        "/m/inventory/stock",
        "/m/board",
        "/m/search",
      ]
        .map(abs)
        .sort(),
    );

    const bounced = loadWorker(() => response("/login", "login page", { redirected: true }));
    await bounced.install();
    expect(cachedUrls(bounced)).toEqual([]);
  });

  it("removes older versioned caches on activate and keeps the current ones", async () => {
    await worker.caches.open("jiangtang-shell-v1");
    await worker.caches.open("jiangtang-shell-v2");
    await worker.caches.open("jiangtang-shell-v4");
    await worker.caches.open("jiangtang-assets-v1");

    await worker.activate();

    expect([...worker.caches.stores.keys()].sort()).toEqual([
      "jiangtang-assets-v1",
      "jiangtang-shell-v4",
    ]);
  });

  it("leaves the asset cache out of the purge", async () => {
    await worker.request("/assets/app-abc123.js");
    await purgeSignedInCaches(asStorage(worker));

    expect(worker.caches.stores.get("jiangtang-assets-v1")?.size).toBe(1);
  });

  it("never forces a waiting update to activate, but claims pages after normal activation", async () => {
    await worker.install();
    await worker.activate();
    expect(worker.lifecycle).toEqual({ skipWaiting: 0, claim: 1 });
  });

  it("revalidates navigations, loader data and precaches instead of using stale HTTP cache", async () => {
    await worker.install();
    await worker.request("/m", { mode: "navigate" });
    await worker.request("/m.data?index");
    await worker.request("/m/tasks.data");
    await worker.request("/api/search?q=room");
    expect(worker.requests.length).toBeGreaterThan(14);
    expect(worker.requests.every((request) => request.cache === "no-cache")).toBe(true);
    await worker.request("/assets/app-new.js");
    expect(worker.requests.at(-1)?.cache).toBeUndefined();
  });

  it("returns the new online document rather than a previously cached deploy", async () => {
    let deploy = "old";
    const updating = loadWorker((url) => response(url, deploy));
    await updating.request("/m", { mode: "navigate" });
    deploy = "new";
    expect((await updating.request("/m", { mode: "navigate" }))?.body).toBe("new");
  });

  it("does not intercept lookalike mobile paths, desktop navigations, mutations or SSE", async () => {
    for (const [path, options] of [
      ["/mobile", { mode: "navigate" }],
      ["/mobile/data", {}],
      ["/more", {}],
      ["/tasks", { mode: "navigate" }],
      ["/m.data", { method: "POST" }],
      ["/api/realtime", {}],
    ] as const) {
      expect(await worker.request(path, options)).toBeUndefined();
    }
    expect(worker.requests).toHaveLength(0);
  });
});

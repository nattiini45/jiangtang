import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** A browser tab for the offline pages' inline scripts: what survives a reload is the storage and the clock. */
export function createTab(opts: { storage?: "works" | "throws" } = {}) {
  const store = new Map<string, string>();
  const clock = { now: 1_700_000_000_000 };
  const sessionStorage = {
    getItem: (key: string) => {
      if (opts.storage === "throws") throw new DOMException("denied", "SecurityError");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (opts.storage === "throws") throw new DOMException("denied", "SecurityError");
      store.set(key, value);
    },
  };

  /** One page load: a fresh script context that shares the tab's storage and clock. */
  function load(
    source: string,
    env: {
      onLine: boolean;
      document?: object;
      navigator?: object;
      extra?: object;
      /** The URL the page shows: the worker serves the placeholder in place of the page that failed. */
      pathname?: string;
    },
  ) {
    const listeners: Record<string, () => void> = {};
    const timers: { delay: number; fn: () => void }[] = [];
    let reloads = 0;
    vm.runInNewContext(source, {
      ...env.extra,
      document: env.document,
      navigator: { onLine: env.onLine, ...env.navigator },
      window: {
        addEventListener: (type: string, fn: () => void) => void (listeners[type] = fn),
        sessionStorage,
      },
      location: { reload: () => void (reloads += 1), pathname: env.pathname ?? "/m/tasks" },
      setTimeout: (fn: () => void, delay: number) => void timers.push({ delay, fn }),
      Date: { now: () => clock.now },
      Math,
    });
    return {
      reloads: () => reloads,
      /** Delays of the reloads this page scheduled for itself. */
      delays: () => timers.map((t) => t.delay),
      fireOnline: () => listeners.online?.(),
      /** Lets the scheduled reloads run, moving the clock by their delay. */
      runTimers: () => {
        for (const t of timers.splice(0)) {
          clock.now += t.delay;
          t.fn();
        }
      },
    };
  }

  return { load, clock, store };
}

/**
 * The reload behaviour both offline pages promise. The service worker's placeholder and the app's
 * /m/offline route each carry their own copy of the script; both run these scenarios.
 * `source` returns the inline script as the page would receive it, `extra` any globals that page
 * needs besides the reload ones.
 */
export function describeOfflineReload(
  name: string,
  source: () => Promise<string> | string,
  extra: () => { document?: object; navigator?: object } = () => ({}),
) {
  describe(`${name}: reload once the connection is back`, () => {
    const open = async (tab: ReturnType<typeof createTab>, onLine: boolean, pathname?: string) =>
      tab.load(await source(), { onLine, pathname, ...extra() });

    it("reloads once on the online event, however often it fires", async () => {
      const page = await open(createTab(), false);
      expect(page.delays()).toEqual([]);

      page.fireOnline();
      page.fireOnline();

      expect(page.reloads()).toBe(1);
    });

    it("does not schedule a reload while the browser reports itself offline", async () => {
      const page = await open(createTab(), false);

      page.runTimers();

      expect(page.reloads()).toBe(0);
    });

    it("retries on its own with a growing delay when it loads while online", async () => {
      const tab = createTab();
      const delays: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const page = await open(tab, true);
        delays.push(...page.delays());
        page.runTimers();
      }

      expect(delays).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    });

    it("reloads when the scheduled delay is over, and only once even if the event also fires", async () => {
      const page = await open(createTab(), true);
      expect(page.reloads()).toBe(0);

      page.runTimers();
      page.fireOnline();

      expect(page.reloads()).toBe(1);
    });

    it("gives up after a bounded number of attempts and still reacts to the online event", async () => {
      const tab = createTab();
      let scheduled = 0;
      for (let i = 0; i < 20; i += 1) {
        const page = await open(tab, true);
        scheduled += page.delays().length;
        page.runTimers();
      }
      const last = await open(tab, true);

      expect(scheduled).toBe(8);
      expect(last.delays()).toEqual([]);
      last.fireOnline();
      expect(last.reloads()).toBe(1);
    });

    it("keeps the bound when every failing reload is slow", async () => {
      const tab = createTab();
      let scheduled = 0;
      // Once a load schedules nothing, nothing reloads the page any more; the bound is how many
      // loads it takes to get there.
      for (let i = 0; i < 20; i += 1) {
        const page = await open(tab, true);
        if (page.delays().length === 0) break;
        scheduled += page.delays().length;
        page.runTimers();
        // The reload itself takes long to fail before the placeholder comes back.
        tab.clock.now += 3 * 60_000;
      }

      expect(scheduled).toBe(8);
    });

    it("starts counting again once the last attempt is long past", async () => {
      const tab = createTab();
      for (let i = 0; i < 20; i += 1) (await open(tab, true)).runTimers();
      expect((await open(tab, true)).delays()).toEqual([]);

      tab.clock.now += 11 * 60_000;

      expect((await open(tab, true)).delays()).toEqual([5000]);
    });

    it("never retries on its own as the /m/offline page itself, but still reacts to online", async () => {
      const page = await open(createTab(), true, "/m/offline");

      expect(page.delays()).toEqual([]);
      page.fireOnline();
      expect(page.reloads()).toBe(1);
    });

    it("keeps to the online event when session storage is not available", async () => {
      const tab = createTab({ storage: "throws" });

      const page = await open(tab, true);
      page.runTimers();
      page.fireOnline();

      expect(page.delays()).toEqual([]);
      expect(page.reloads()).toBe(1);
    });
  });
}

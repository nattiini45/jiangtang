import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeRegisterServiceWorker } from "../register-sw";

afterEach(() => vi.unstubAllGlobals());

function browser(path = "/m", readyState = "complete") {
  const window = Object.assign(new EventTarget(), {
    location: { pathname: path, origin: "https://app.test" },
  });
  const document = Object.assign(new EventTarget(), { readyState, visibilityState: "visible" });
  const installing = new EventTarget();
  const registration = Object.assign(new EventTarget(), {
    scope: "https://app.test/m",
    active: {} as object | null,
    installing,
    waiting: null as EventTarget | null,
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => true),
  });
  const legacy = { scope: "https://app.test/m/", unregister: vi.fn(async () => true) };
  const unrelated = { scope: "https://app.test/other/", unregister: vi.fn(async () => true) };
  const register = vi.fn(async () => registration);
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", {
    serviceWorker: {
      register,
      getRegistrations: async () => [registration, legacy, unrelated],
    },
  });
  return { window, document, registration, installing, legacy, unrelated, register };
}

describe("mobile service worker registration", () => {
  it("covers /m exactly, bypasses the script HTTP cache and retires only the legacy /m/ scope", async () => {
    const app = browser();
    const stop = maybeRegisterServiceWorker();
    await vi.waitFor(() => expect(app.legacy.unregister).toHaveBeenCalledOnce());
    expect(app.register).toHaveBeenCalledWith("/sw.js", { scope: "/m", updateViaCache: "none" });
    expect(app.registration.unregister).not.toHaveBeenCalled();
    expect(app.unrelated.unregister).not.toHaveBeenCalled();
    stop();
  });

  it.each(["/", "/mobile", "/more", "/m.data"])("does not register on %s", (path) => {
    const app = browser(path);
    maybeRegisterServiceWorker()();
    expect(app.register).not.toHaveBeenCalled();
  });

  it("registers after load and cancels an unmounted pending registration", () => {
    const app = browser("/m/tasks", "loading");
    const stop = maybeRegisterServiceWorker();
    expect(app.register).not.toHaveBeenCalled();
    stop();
    app.window.dispatchEvent(new Event("load"));
    expect(app.register).not.toHaveBeenCalled();
    maybeRegisterServiceWorker();
    app.window.dispatchEvent(new Event("load"));
    expect(app.register).toHaveBeenCalledOnce();
  });

  it("reports an already waiting worker without sending an activation or reloading", async () => {
    const app = browser();
    app.registration.waiting = new EventTarget();
    const ready = vi.fn();
    const stop = maybeRegisterServiceWorker(ready);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    stop();
    app.document.dispatchEvent(new Event("visibilitychange"));
    expect(app.registration.update).not.toHaveBeenCalled();
  });

  it("does not mistake the first installation's transient waiting state for an update", async () => {
    const app = browser();
    app.registration.active = null;
    app.registration.waiting = new EventTarget();
    const ready = vi.fn();
    const stop = maybeRegisterServiceWorker(ready);
    await vi.waitFor(() => expect(app.legacy.unregister).toHaveBeenCalledOnce());
    app.installing.dispatchEvent(new Event("statechange"));
    expect(ready).not.toHaveBeenCalled();
    stop();
  });

  it("reports a newly installed waiting update and checks again when the app returns to foreground", async () => {
    const app = browser();
    const ready = vi.fn();
    const stop = maybeRegisterServiceWorker(ready);
    await vi.waitFor(() => expect(app.legacy.unregister).toHaveBeenCalledOnce());
    app.registration.waiting = new EventTarget();
    app.installing.dispatchEvent(new Event("statechange"));
    expect(ready).toHaveBeenCalledOnce();
    app.document.dispatchEvent(new Event("visibilitychange"));
    expect(app.registration.update).toHaveBeenCalledOnce();
    stop();
    app.installing.dispatchEvent(new Event("statechange"));
    expect(ready).toHaveBeenCalledOnce();
  });

  it("fails non-fatally when registration is unavailable", async () => {
    const app = browser();
    app.register.mockRejectedValueOnce(new Error("blocked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = maybeRegisterServiceWorker();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(app.legacy.unregister).not.toHaveBeenCalled();
    stop();
    warn.mockRestore();
  });
});

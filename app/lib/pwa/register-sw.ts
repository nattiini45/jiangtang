/**
 * Service-worker registration. Registered only on the /m
 * surface so the desktop never installs a SW. The SW precaches the shell +
 * serves a NetworkFirst strategy so stale bookings are never shown. What it
 * caches is signed-in content; the sign-in page clears it (purge-caches.ts).
 *
 * Client-only (guards `navigator`) — call from the mobile layout's useEffect.
 */
export function maybeRegisterServiceWorker(onUpdateReady: () => void = () => {}): () => void {
  const noop = () => {};
  if (typeof window === "undefined") return noop;
  if (!("serviceWorker" in navigator)) return noop;
  // Scope the SW to /m so the desktop is unaffected.
  if (!/^\/m(?:\/|$)/.test(window.location.pathname)) return noop;

  let disposed = false;
  let registration: ServiceWorkerRegistration | undefined;
  let installing: ServiceWorker | null = null;
  const inspect = () => {
    if (!disposed && registration?.active && registration.waiting) onUpdateReady();
  };
  const trackInstalling = () => {
    installing?.removeEventListener("statechange", inspect);
    installing = registration?.installing ?? null;
    installing?.addEventListener("statechange", inspect);
    inspect();
  };
  const checkForUpdate = () => {
    if (document.visibilityState === "visible") void registration?.update().catch(() => {});
  };

  const register = () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/m", updateViaCache: "none" })
      .then(async (result) => {
        if (disposed) return;
        registration = result;
        registration.addEventListener("updatefound", trackInstalling);
        document.addEventListener("visibilitychange", checkForUpdate);
        trackInstalling();
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations
            .filter((entry) => entry.scope === new URL("/m/", window.location.origin).href)
            .map((entry) => entry.unregister()),
        );
      })
      .catch((e) => {
        // SW registration failure is non-fatal — the app still works online.
        console.warn("[pwa] service worker registration failed:", e);
      });
  };

  // The caller runs from a mount effect, which can fire AFTER the window `load`
  // event on a fast page — waiting for another `load` would never register.
  // Register immediately once the document is complete; otherwise wait, once.
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
  return () => {
    disposed = true;
    window.removeEventListener("load", register);
    document.removeEventListener("visibilitychange", checkForUpdate);
    registration?.removeEventListener("updatefound", trackInstalling);
    installing?.removeEventListener("statechange", inspect);
  };
}

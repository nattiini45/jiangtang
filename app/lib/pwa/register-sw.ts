/**
 * Service-worker registration. Registered only on the /m
 * surface so the desktop never installs a SW. The SW precaches the shell +
 * serves a NetworkFirst strategy so stale bookings are never shown. What it
 * caches is signed-in content; the sign-in page clears it (purge-caches.ts).
 *
 * Client-only (guards `navigator`) — call from the mobile layout's useEffect.
 */
export function maybeRegisterServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  // Scope the SW to /m so the desktop is unaffected.
  if (!window.location.pathname.startsWith("/m")) return;

  const register = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/m/" }).catch((e) => {
      // SW registration failure is non-fatal — the app still works online.
      console.warn("[pwa] service worker registration failed:", e);
    });
  };

  // The caller runs from a mount effect, which can fire AFTER the window `load`
  // event on a fast page — waiting for another `load` would never register.
  // Register immediately once the document is complete; otherwise wait, once.
  if (document.readyState === "complete") {
    register();
    return;
  }
  window.addEventListener("load", register, { once: true });
}

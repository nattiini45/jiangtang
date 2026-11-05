/**
 * Every cache the service worker (public/sw.js) fills with signed-in content: server-rendered
 * pages, loader data, uploaded images and API answers. Those are keyed by URL, not by person, so
 * they must not outlive the session that fetched them. Matches every version of the name, so a
 * cache left by an older worker goes too. The immutable-asset cache holds no personal data and is
 * deliberately not matched.
 */
const SIGNED_IN_CACHE_PREFIX = "jiangtang-shell-";

/**
 * Deletes the service worker's signed-in caches and returns their names. Called from the sign-in
 * page: sign-out and every expired-session redirect end there, and CacheStorage is shared by the
 * whole origin, so the page can clear what the worker (scoped to /m/) stored. Best effort: it
 * never throws, because a failure here must not stop anyone from signing in.
 */
export async function purgeSignedInCaches(
  storage: CacheStorage | undefined = typeof caches === "undefined" ? undefined : caches,
): Promise<string[]> {
  if (!storage) return [];
  try {
    const names = (await storage.keys()).filter((name) => name.startsWith(SIGNED_IN_CACHE_PREFIX));
    await Promise.all(names.map((name) => storage.delete(name)));
    return names;
  } catch (e) {
    console.warn("[pwa] clearing cached pages failed:", e);
    return [];
  }
}

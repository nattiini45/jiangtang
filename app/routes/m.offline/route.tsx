import { WifiOff } from "lucide-react";
import type { Route } from "./+types/route";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";
import { OFFLINE_RELOAD_SCRIPT } from "~/lib/pwa/offline-reload-script";

/**
 * Offline fallback shell (PWA). Precached by the service
 * worker (public/sw.js SHELL_URLS) and served from cache when a navigation
 * fails while offline (networkFirst() falls back to cache.match("/m/offline")).
 *
 * No loader — it must render purely from the cache with no network dependency.
 * It still renders inside the auth-guarded `m` layout (app/routes/m/route.tsx),
 * so the *first* fetch of this page (at SW install time, or a normal online
 * navigation) goes through requireUser like any other /m route. Once cached,
 * the SW serves that cached (already-authenticated) HTML response directly
 * on subsequent offline navigations without re-running the loader — so this
 * page does not need to be public for the offline fallback to work.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.offline") }];
}

export default function MobileOffline() {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <span className="bg-tint flex size-14 items-center justify-center rounded-full">
        <WifiOff className="text-muted-foreground size-6" strokeWidth={1.5} />
      </span>
      <h1 className="text-lg font-semibold">{t("mobile.offline.title")}</h1>
      <p className="text-muted-foreground text-sm">{t("mobile.offline.body")}</p>
      {/* The body promises a refresh once the connection is back. The worker serves this page's
          HTML in place of the one that failed, so reloading re-requests that URL. It is markup,
          not an effect, because the route's JS is normally not available offline to hydrate. */}
      <script dangerouslySetInnerHTML={{ __html: OFFLINE_RELOAD_SCRIPT }} />
    </div>
  );
}

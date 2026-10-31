import * as React from "react";
import { useRevalidator } from "react-router";

/**
 * Live-refetch hook. Opens one `EventSource` to the auth-gated
 * `/api/realtime` SSE stream and calls React Router's `revalidator.revalidate()`
 * on every `change` event AND on (re)connect — so a client that briefly lost the
 * stream refetches on reconnect and never sits on stale bookings
 * ("refetch-on-connect", and "live updates are an accelerator, not truth").
 *
 * Mount once per surface (desktop `_desktop` layout, mobile `m` layout). The
 * `EventSource` is browser-scoped, so this hook is a no-op during SSR.
 */
export function useLiveRefetch(): void {
  const { revalidate } = useRevalidator();

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    // EventSource sends cookies by default (same-origin) — the auth session is
    // carried on the cookie, so the stream is authenticated without a token.
    const es = new EventSource("/api/realtime");

    const handleChange = (): void => {
      void revalidate();
    };

    es.addEventListener("open", handleChange); // refetch-on-connect / reconnect
    es.addEventListener("change", handleChange);
    // A client-visible `error` fires on drop; EventSource auto-reconnects, and
    // the next `open` re-triggers a refetch. Nothing to do here but let it ride.

    return () => {
      es.removeEventListener("open", handleChange);
      es.removeEventListener("change", handleChange);
      es.close();
    };
  }, [revalidate]);
}

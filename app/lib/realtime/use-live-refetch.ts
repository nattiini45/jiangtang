import * as React from "react";
import { useRevalidator } from "react-router";
import { connectLive, probeStream } from "~/lib/realtime/live-connection";

const STREAM_URL = "/api/realtime";

/**
 * Live-refetch hook. Opens one `EventSource` to the auth-gated `/api/realtime`
 * SSE stream and calls React Router's `revalidator.revalidate()` on every
 * `change` event and on every (re)connect, so a client that lost the stream
 * refetches once it is back and never sits on stale bookings. Live updates are
 * an accelerator, not the source of truth.
 *
 * Reconnecting after a fatal stream error (which a browser `EventSource` does
 * not do on its own) lives in `live-connection.ts`.
 *
 * Mount once per surface (desktop `_desktop` layout, mobile `m` layout). The
 * `EventSource` is browser-scoped, so this hook is a no-op during SSR.
 */
export function useLiveRefetch(): void {
  const { revalidate } = useRevalidator();

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    // EventSource sends cookies by default (same-origin), so the stream is
    // authenticated by the session cookie without a token.
    const conn = connectLive({
      url: STREAM_URL,
      createEventSource: (url) => new EventSource(url),
      onRevalidate: () => {
        void revalidate();
      },
      probe: probeStream,
    });

    const onOnline = (): void => conn.reconnectNow();
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("online", onOnline);
      conn.close();
    };
  }, [revalidate]);
}

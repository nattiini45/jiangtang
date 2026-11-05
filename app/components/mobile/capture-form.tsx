import * as React from "react";
import { Link } from "react-router";
import { CloudOff, Trash2 } from "lucide-react";
import {
  captureOrQueue,
  defaultStore,
  MemoryQueueStore,
  useOfflineQueue,
  useQueueOwner,
  type CaptureResult,
  type QueuedCapture,
} from "~/lib/pwa/offline-queue";
import { useT } from "~/i18n/use-t";

/**
 * Offline-capable capture form. Intercepts submit, POSTs the fields to
 * the route's own action; a network failure queues the entry under a
 * client-generated id and shows the "saved offline" notice. The action treats the
 * capture header as a JSON request and dedupes on `clientId`, so a replayed
 * entry can never create a second row.
 *
 * `submit(form, { queue: false })` sends without the fallback: a capture the
 * queue cannot hold in full (a ticket with photos) is then never stored, the
 * result is still `queued` (nothing was sent), and the state is `unsent` or
 * `unsentSignin` so the page can keep the form and let the person choose.
 */
export function useCaptureSubmit(action: string) {
  const [state, setState] = React.useState<
    "idle" | "sending" | "queued" | "signin" | "unsent" | "unsentSignin" | "refused"
  >("idle");
  const [error, setError] = React.useState<string | null>(null);
  const t = useT();
  const userId = useQueueOwner();

  const submit = React.useCallback(
    async (
      form: HTMLFormElement,
      { queue = true }: { queue?: boolean } = {},
    ): Promise<CaptureResult | null> => {
      const fields: Record<string, string> = {};
      new FormData(form).forEach((v, k) => {
        if (typeof v === "string") fields[k] = v;
      });
      setState("sending");
      setError(null);
      // Without the fallback the "queued" entry lands in a throwaway store.
      const store = queue ? defaultStore() : new MemoryQueueStore();
      const result = await captureOrQueue(action, fields, store, fetch, userId);
      if (result.state === "sent") {
        setState("idle");
      } else if (result.state === "queued" && !queue) {
        setState(result.authRequired ? "unsentSignin" : "unsent");
      } else if (result.state === "queued") {
        // "signin" is announced by CaptureQueueStatus, which reads the stored entry.
        setState(result.authRequired ? "signin" : "queued");
      } else {
        setState("refused");
        setError(result.error ?? t("mobile.capture.rejected"));
      }
      return result;
    },
    [action, t, userId],
  );

  return { state, error, submit };
}

/**
 * The queued-state notice + this page's refused entries with a discard. The
 * sign-in notice follows the whole queue, not only this page's entries: it is
 * shown even when every waiting entry belongs to another capture page, since
 * those are blocked behind the same expired session.
 */
export function CaptureQueueStatus({ url }: { url: string }) {
  const { entries, authRequired, discard } = useOfflineQueue();
  return (
    <CaptureQueuePanel
      url={url}
      entries={entries}
      authRequired={authRequired}
      onDiscard={(clientId) => void discard(clientId)}
    />
  );
}

/** `entries` is the whole visible queue; the panel picks this page's own. */
export function CaptureQueuePanel({
  url,
  entries,
  authRequired,
  onDiscard,
}: {
  url: string;
  entries: QueuedCapture[];
  authRequired: boolean;
  onDiscard: (clientId: string) => void;
}) {
  const mine = entries.filter((e) => e.url === url);
  if (mine.length === 0 && !authRequired) return null;
  return (
    <CaptureQueueList url={url} entries={mine} signInNeeded={authRequired} onDiscard={onDiscard} />
  );
}

export function CaptureQueueList({
  url,
  entries,
  signInNeeded,
  onDiscard,
}: {
  url: string;
  entries: QueuedCapture[];
  signInNeeded: boolean;
  onDiscard: (clientId: string) => void;
}) {
  const t = useT();
  return (
    <>
      {signInNeeded ? (
        <p
          role="status"
          className="bg-status-warning/15 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 text-sm"
        >
          {t("mobile.capture.signInNeeded")}
          <Link
            to={`/login?next=${encodeURIComponent(url)}`}
            className="flex min-h-11 items-center font-semibold underline underline-offset-4"
          >
            {t("mobile.capture.signInAction")}
          </Link>
        </p>
      ) : null}
      {entries.length > 0 ? (
        <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
          {entries.map((e) => (
            <li key={e.clientId} className="flex min-h-12 items-start gap-3 px-3 py-3 text-sm">
              <span className="bg-status-warning/15 text-status-warning mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
                <CloudOff className="size-3.5" strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">
                  {t("mobile.capture.pending", {
                    title: e.fields.title ?? e.fields.q ?? t("mobile.capture.entryFallback"),
                  })}
                </div>
                {e.error ? <div className="text-destructive mt-0.5 text-xs">{e.error}</div> : null}
              </div>
              <button
                type="button"
                onClick={() => onDiscard(e.clientId)}
                aria-label={t("mobile.capture.discard")}
                className="text-muted-foreground active:text-destructive active:bg-selected flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md transition-colors duration-80"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

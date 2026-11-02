import * as React from "react";
import { CloudOff, Trash2 } from "lucide-react";
import { captureOrQueue, useOfflineQueue, type CaptureResult } from "~/lib/pwa/offline-queue";
import { useT } from "~/i18n/use-t";

/**
 * Offline-capable capture form. Intercepts submit, POSTs the fields to
 * the route's own action; a network failure queues the entry under a
 * client-generated id and shows the "saved offline" notice. The action treats the
 * capture header as a JSON request and dedupes on `clientId`, so a replayed
 * entry can never create a second row.
 */
export function useCaptureSubmit(action: string) {
  const [state, setState] = React.useState<"idle" | "sending" | "queued" | "refused">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const t = useT();

  const submit = React.useCallback(
    async (form: HTMLFormElement): Promise<CaptureResult | null> => {
      const fields: Record<string, string> = {};
      new FormData(form).forEach((v, k) => {
        if (typeof v === "string") fields[k] = v;
      });
      setState("sending");
      setError(null);
      const result = await captureOrQueue(action, fields);
      if (result.state === "sent") {
        setState("idle");
      } else if (result.state === "queued") {
        setState("queued");
      } else {
        setState("refused");
        setError(result.error ?? t("mobile.capture.rejected"));
      }
      return result;
    },
    [action, t],
  );

  return { state, error, submit };
}

/** The queued-state notice + this page's refused entries with a discard. */
export function CaptureQueueStatus({ url }: { url: string }) {
  const { entries, discard } = useOfflineQueue();
  const t = useT();
  const mine = entries.filter((e) => e.url === url);
  if (mine.length === 0) return null;
  return (
    <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
      {mine.map((e) => (
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
            onClick={() => void discard(e.clientId)}
            aria-label={t("mobile.capture.discard")}
            className="text-muted-foreground active:text-destructive active:bg-selected flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md transition-colors duration-80"
          >
            <Trash2 className="size-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}

import * as React from "react";
import { useFetcher } from "react-router";
import { formatDateWith } from "~/i18n/format";
import type { Locale } from "~/i18n/locales";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Pre-save conflict indicator. Watches the room/equipment + time
 * inputs inside an add-form, debounces, and asks `/api/events/check-conflict`.
 * Renders an inline badge listing the conflicting events so the user sees the
 * clash BEFORE submitting. The DB GiST EXCLUDE stays the authority — this is the
 * accelerator. Purely advisory; the submit button remains enabled (the user may
 * still submit and let the server return the authoritative 409).
 */

interface Conflict {
  eventId: string;
  eventTitle: string;
  startsAt: string;
  endsAt: string;
}

export function ConflictCheck({
  kind,
  formId,
  excludeBookingId,
}: {
  kind: "room" | "equipment";
  /** The <form id=…> whose inputs to watch (the add-form in event-detail). */
  formId: string;
  /**
   * When editing an existing room booking / allocation, pass its id so the
   * check excludes it from the conflict set (otherwise an edit form would
   * always conflict with itself). Unset for the "add new" forms.
   * NOTE: this is a deliberately minimal, additive fix — the larger refactor to
   * a fully controlled edit form (so this component can also prefill from the
   * booking being edited) is out of scope here.
   */
  excludeBookingId?: string;
}) {
  const locale = useLocale();
  const t = useT();
  const fetcher = useFetcher<{ conflicts: Conflict[] }>();
  const lastKey = React.useRef<string>("");
  const debounce = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const readInputs = React.useCallback((): {
    id: string;
    startsAt: string;
    endsAt: string;
  } | null => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return null;
    const idEl = form.querySelector<HTMLSelectElement>(
      kind === "room" ? 'select[name="roomId"]' : 'select[name="equipmentId"]',
    );
    const startEl = form.querySelector<HTMLInputElement>('input[name="startsAt"]');
    const endEl = form.querySelector<HTMLInputElement>('input[name="endsAt"]');
    const id = idEl?.value ?? "";
    const startsAt = startEl?.value ?? "";
    const endsAt = endEl?.value ?? "";
    if (!id || !startsAt || !endsAt) return null;
    return { id, startsAt, endsAt };
  }, [formId, kind]);

  // Poll the form's inputs; when they change, debounce a fresh check.
  React.useEffect(() => {
    const poll = (): void => {
      const vals = readInputs();
      const key = vals ? `${vals.id}|${vals.startsAt}|${vals.endsAt}` : "";
      if (key === lastKey.current) return;
      lastKey.current = key;
      if (debounce.current) clearTimeout(debounce.current);
      if (!vals) return;
      debounce.current = setTimeout(() => {
        const params = new URLSearchParams({
          kind,
          id: vals.id,
          startsAt: vals.startsAt,
          endsAt: vals.endsAt,
        });
        if (excludeBookingId) params.set("exclude", excludeBookingId);
        void fetcher.load(`/api/events/check-conflict?${params.toString()}`);
      }, 350);
    };
    const handle = setInterval(poll, 400);
    return () => {
      clearInterval(handle);
      if (debounce.current) clearTimeout(debounce.current);
    };
    // fetcher.load is stable; exclude from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, formId, excludeBookingId]);

  const conflicts = fetcher.data?.conflicts ?? [];

  if (conflicts.length === 0) {
    return <p className="text-muted-foreground text-xs">{t("events.conflict.none")}</p>;
  }
  return (
    <div className="border-status-fault/40 bg-status-fault/10 text-status-fault border p-2 text-xs">
      <p className="font-medium">
        {conflicts.length === 1
          ? t("events.conflict.headingOne")
          : t("events.conflict.headingOther", { count: conflicts.length })}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {conflicts.map((c) => (
          <li key={c.eventId + c.startsAt} className="font-mono">
            {c.eventTitle} · {fmt(locale, c.startsAt)}–{fmt(locale, c.endsAt)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmt(locale: Locale, iso: string): string {
  try {
    return formatDateWith(locale, iso, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

import * as React from "react";
import { useNavigate } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { resolveLocale } from "~/i18n/locale.server";
import { CAPTURE_HEADER } from "~/lib/pwa/offline-queue";
import { assertCaptureOwner } from "~/lib/pwa/capture-owner.server";
import { CaptureQueueStatus, useCaptureSubmit } from "~/components/mobile/capture-form";
import { emitChange } from "~/lib/realtime/emit.server";
import { listTicketTargets } from "~/domains/tickets/tickets.queries.server";
import { ticketCreateSchema } from "~/domains/tickets/tickets.schema";
import { createTicket } from "~/domains/tickets/tickets.mutations.server";
import { TicketType, TicketStatus } from "~/generated/prisma/enums";
import { MobilePhotoCapture } from "~/components/mobile/mobile-photo-capture";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ticketTypeLabel } from "~/components/tickets/labels";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile quick-entry (the primary action on the PWA). Same
 * createTicket action as the desktop quick-entry (no domain code fork), with a
 * mobile-first single-column form + camera capture. Captured photos are uploaded
 * after the ticket exists, via the existing attachments.upload route.
 *
 * The submit goes through the offline capture queue, like `/m/tasks/new`: the
 * `clientId` it mints becomes the ticket's id, so a replay cannot double the row.
 * The queue stores form fields only, so a ticket with photos is never queued
 * silently: offline, the form keeps the photos and the person chooses to retry
 * or to save the entry offline without them. `/m` is an index route, so the
 * queue posts to `/m?index` (data URL `/m.data?index`).
 *
 * The action answers the capture header with `{ id }` JSON; a plain form post
 * gets `{ createdTicketId }` as before.
 */
const CAPTURE_URL = "/m?index";
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.entry") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const targets = await listTicketTargets();
  return { rooms: targets.rooms, equipment: targets.equipment };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  assertCaptureOwner(request, actor);
  const locale = resolveLocale(request);
  const wantsJson = request.headers.get(CAPTURE_HEADER) === "1";
  const { clientId, ...rest } = formDataToObject(await request.formData());
  const parsed = safeParse(ticketCreateSchema, rest, locale);
  // A queued entry carries its capture time, so a replay hours later is still
  // logged when it happened. The phone's clock may run ahead: never later than now.
  if (parsed.success && parsed.data.occurredAt && parsed.data.occurredAt > new Date()) {
    parsed.data.occurredAt = new Date();
  }
  try {
    if (!parsed.success) {
      throw new ValidationError(parsed.fieldErrors, parsed.formErrors);
    }
    const ticket = await createTicket(
      actor,
      parsed.data,
      typeof clientId === "string" && clientId !== "" ? clientId : undefined,
    );
    await emitChange({ entityType: "ticket", id: ticket.id, op: "created" });
    if (wantsJson) return Response.json({ id: ticket.id });
    return { createdTicketId: ticket.id };
  } catch (e) {
    if (e instanceof ValidationError) {
      if (wantsJson) {
        const msg = [...e.formErrors, ...Object.values(e.fieldErrors).flat()].join(" · ");
        return Response.json(
          { error: msg || translate(locale, "err.invalidInput") },
          { status: 400 },
        );
      }
      return { fieldErrors: e.fieldErrors };
    }
    throw toErrorResponse(e);
  }
}

export default function MobileQuickEntry({ loaderData, actionData }: Route.ComponentProps) {
  const { rooms, equipment } = loaderData;
  const t = useT();
  const locale = useLocale();
  const navigate = useNavigate();
  const { state, error, submit } = useCaptureSubmit(CAPTURE_URL);
  const busy = state === "sending";
  const [sentId, setSentId] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [pendingPhotos, setPendingPhotos] = React.useState<File[]>([]);
  const formRef = React.useRef<HTMLFormElement>(null);
  // The capture time of the current entry: the time of its first attempt, kept
  // across retries. Held here, not in the DOM, since React re-applies the hidden
  // input's default value on every render.
  const capturedAt = React.useRef<string | null>(null);
  // Remounts the photo widget, whose own counter would still count dropped photos.
  const [photoKey, setPhotoKey] = React.useState(0);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const startedRef = React.useRef(false);
  const createdId =
    sentId ?? (actionData && "createdTicketId" in actionData ? actionData.createdTicketId : null);
  const fieldErrors =
    actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined;

  // Upload the captured photos to the freshly created ticket. Only redirect once
  // EVERY photo is confirmed stored — a failed upload keeps the user here with a
  // retry so evidence is never silently dropped (see uploadSucceeded for why a bare
  // response.ok isn't enough: the upload route surfaces errors via a followed redirect).
  const uploadPending = React.useCallback(async () => {
    if (!createdId || pendingPhotos.length === 0) return;
    setUploadError(null);
    setUploading(true);
    const failed: File[] = [];
    await Promise.all(
      pendingPhotos.map(async (file) => {
        try {
          const fd = new FormData();
          fd.append("file", file);
          fd.append("ticketId", createdId);
          fd.append("category", "TICKET");
          fd.append("redirectTo", "/m/rooms");
          const res = await fetch("/attachments/upload", { method: "POST", body: fd });
          if (!uploadSucceeded(res)) failed.push(file);
        } catch {
          // Network/offline — the exact PWA scenario this surface targets.
          failed.push(file);
        }
      }),
    );
    if (failed.length === 0) {
      void navigate("/m/rooms");
      return;
    }
    setUploadError(
      t("mobile.entry.uploadFailed", { failed: failed.length, total: pendingPhotos.length }),
    );
    setPendingPhotos(failed); // retry re-uploads only the ones that failed
    setUploading(false);
  }, [createdId, pendingPhotos, navigate, t]);

  // Auto-run the upload exactly once after the ticket is created; retries are manual
  // (the startedRef guard stops setPendingPhotos from re-triggering an upload loop).
  React.useEffect(() => {
    if (!createdId || startedRef.current) return;
    startedRef.current = true;
    if (pendingPhotos.length === 0) {
      void navigate("/m/rooms");
      return;
    }
    void uploadPending();
  }, [createdId, pendingPhotos, uploadPending, navigate]);

  if (createdId) {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-4">
        <p className="text-status-operational text-sm font-semibold">{t("mobile.entry.created")}</p>
        {uploadError ? (
          <>
            <p className="text-destructive text-sm" role="alert">
              {uploadError}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                onClick={() => void uploadPending()}
                disabled={uploading}
                className="min-h-11"
              >
                {uploading ? t("mobile.entry.uploading") : t("mobile.entry.retry")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => navigate("/m/rooms")}
                className="text-muted-foreground min-h-11"
              >
                {t("mobile.entry.continueWithout")}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-muted-foreground text-xs">
            {pendingPhotos.length > 0 ? t("mobile.entry.uploading") : t("mobile.entry.redirecting")}
          </p>
        )}
      </div>
    );
  }

  // `queue: false` while photos are attached: the queue holds fields only, and
  // queueing would leave the photos behind without the person deciding so.
  const send = async (form: HTMLFormElement, queue: boolean) => {
    // The capture time travels with the entry (see the action).
    capturedAt.current ??= new Date().toISOString();
    const stamp = form.elements.namedItem("occurredAt");
    if (stamp instanceof HTMLInputElement) stamp.value = capturedAt.current;
    const result = await submit(form, { queue });
    // Sent or stored: the next submit is a new entry with its own time.
    if (result?.state === "sent" || (result?.state === "queued" && queue)) {
      capturedAt.current = null;
    }
    if (result?.state === "sent") {
      if (result.id) setSentId(result.id);
      else void navigate("/m/rooms");
    } else if (result?.state === "queued" && queue) {
      // Stored and listed below; a filled form invites a second tap, which
      // would queue the same capture again under a new id.
      form.reset();
      setDone(false);
      setPendingPhotos([]);
      setPhotoKey((k) => k + 1);
    }
  };

  const unsent = state === "unsent" || state === "unsentSignin";

  return (
    <form
      ref={formRef}
      method="post"
      // Before hydration this is a native post: `?index` targets this index
      // route's action rather than the /m layout.
      action={CAPTURE_URL}
      className="flex flex-col gap-4 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void send(e.currentTarget, pendingPhotos.length === 0);
      }}
    >
      <h1 className="text-lg font-semibold">{t("mobile.entry.title")}</h1>
      <input type="hidden" name="occurredAt" />

      <Label className="flex flex-col gap-1.5">
        <span>{t("mobile.entry.room")}</span>
        <Select name="roomId" defaultValue="" className="[&>select]:h-11">
          <option value="">{t("mobile.entry.roomPlaceholder")}</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Label>

      <Label className="flex flex-col gap-1.5">
        <span>{t("mobile.entry.equipment")}</span>
        <Select name="equipmentId" defaultValue="" className="[&>select]:h-11">
          <option value="">{t("tickets.form.noEquipment")}</option>
          {equipment.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </Select>
      </Label>

      <Label className="flex flex-col gap-1.5">
        <span>{t("mobile.entry.type")}</span>
        <Select name="type" defaultValue={TicketType.INCIDENT} className="[&>select]:h-11">
          {Object.values(TicketType).map((type) => (
            <option key={type} value={type}>
              {ticketTypeLabel(locale, type)}
            </option>
          ))}
        </Select>
      </Label>

      <Label className="flex flex-col gap-1.5">
        <span>{t("mobile.entry.what")}</span>
        <Input
          name="title"
          required
          placeholder={t("mobile.entry.whatPlaceholder")}
          className="min-h-11"
        />
      </Label>
      {fieldErrors?.title ? (
        <p className="text-destructive text-xs">{fieldErrors.title[0]}</p>
      ) : null}

      <Label className="flex flex-col gap-1.5">
        <span>{t("mobile.entry.details")}</span>
        <Textarea name="description" rows={3} placeholder={t("mobile.entry.detailsPlaceholder")} />
      </Label>

      {/* Camera capture — photos ride along after the ticket is created. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">{t("mobile.entry.photo")}</span>
        <MobilePhotoCapture
          key={photoKey}
          onCapture={(f) => setPendingPhotos((p) => [...p, f])}
          existingCount={0}
        />
      </div>

      <details className="bg-card shadow-surface-2 overflow-hidden rounded-lg">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-semibold">
          {t("mobile.entry.alreadyDone")}
        </summary>
        <div className="flex flex-col gap-4 border-t px-3 py-3">
          <Label className="flex min-h-11 items-center gap-3 text-sm font-normal">
            <Checkbox
              className="size-5"
              checked={done}
              onChange={(e) => setDone(e.target.checked)}
            />
            {t("mobile.entry.doneLog")}
          </Label>
          <input
            type="hidden"
            name="status"
            value={done ? TicketStatus.RESOLVED : TicketStatus.OPEN}
          />
          <Label className="flex flex-col gap-1.5">
            <span>{t("mobile.entry.resolution")}</span>
            <Textarea name="resolution" rows={2} />
          </Label>
        </div>
      </details>

      {state === "queued" || state === "signin" ? (
        <p role="status" className="bg-status-warning/15 rounded-md px-3 py-2 text-sm">
          {t(state === "signin" ? "mobile.capture.queuedSignIn" : "mobile.capture.queued")}
        </p>
      ) : null}
      {unsent ? (
        <div role="alert" className="bg-status-warning/15 flex flex-col gap-2 rounded-md px-3 py-2">
          <p className="text-sm">
            {t(
              state === "unsentSignin" ? "mobile.entry.unsentSignIn" : "mobile.entry.unsentPhotos",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className="min-h-11"
            onClick={() => {
              // The person chose to drop the photos: if the connection is back
              // and the entry goes out now, they must not be uploaded after all.
              setPendingPhotos([]);
              setPhotoKey((k) => k + 1);
              if (formRef.current) void send(formRef.current, true);
            }}
          >
            {t("mobile.entry.saveWithoutPhotos")}
          </Button>
        </div>
      ) : null}
      {state === "refused" && error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={busy} className="h-12 w-full">
        {busy
          ? t("mobile.entry.submitting")
          : unsent
            ? t("mobile.entry.retry")
            : t("mobile.entry.submit")}
      </Button>

      <CaptureQueueStatus url={CAPTURE_URL} />
    </form>
  );
}

/**
 * Did an /attachments/upload POST actually store the file? A bare `res.ok` is not
 * enough: that route reports recoverable failures (file too large, EXIF-strip /
 * unsupported image, unknown target id) as a redirect back to redirectTo carrying
 * ?uploadError=… — which fetch follows to a 200. So treat a followed error redirect
 * as failure too. Only hard rejects (413 oversized body, 500) are already non-2xx.
 */
function uploadSucceeded(res: Response): boolean {
  if (!res.ok) return false;
  try {
    return !new URL(res.url).searchParams.has("uploadError");
  } catch {
    // Unparseable/empty res.url (some edge runtimes): fail closed so the retry UI
    // surfaces it. Never silently drop a photo — a spurious retry is the safe error.
    return false;
  }
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";

import * as React from "react";
import { Form, useNavigate, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { listTicketTargets } from "~/domains/tickets/tickets.queries.server";
import { ticketCreateSchema } from "~/domains/tickets/tickets.schema";
import { createTicket } from "~/domains/tickets/tickets.mutations.server";
import { TicketType, TicketStatus } from "~/generated/prisma/enums";
import { MobilePhotoCapture } from "~/components/mobile/mobile-photo-capture";
import { Button } from "~/components/ui/button";
import { ticketTypeLabel } from "~/components/tickets/labels";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile quick-entry (the primary action on the PWA). Same
 * createTicket action as the desktop quick-entry (no domain code fork), with a
 * mobile-first single-column form + camera capture. Captured photos are uploaded
 * after the ticket exists, via the existing attachments.upload route.
 */
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
  const result = await safeParseForm(request, ticketCreateSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors };
  try {
    const ticket = await createTicket(actor, result.data);
    await emitChange({ entityType: "ticket", id: ticket.id, op: "created" });
    return { createdTicketId: ticket.id };
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export default function MobileQuickEntry({ loaderData, actionData }: Route.ComponentProps) {
  const { rooms, equipment } = loaderData;
  const t = useT();
  const locale = useLocale();
  const nav = useNavigation();
  const navigate = useNavigate();
  const busy = nav.state !== "idle";
  const [pendingPhotos, setPendingPhotos] = React.useState<File[]>([]);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const startedRef = React.useRef(false);
  const createdId =
    actionData && "createdTicketId" in actionData ? actionData.createdTicketId : null;
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
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-status-operational font-mono text-sm">{t("mobile.entry.created")}</p>
        {uploadError ? (
          <>
            <p className="text-destructive text-sm" role="alert">
              {uploadError}
            </p>
            <div className="flex items-center gap-4">
              <Button
                type="button"
                onClick={() => void uploadPending()}
                disabled={uploading}
                className="h-11 text-base"
              >
                {uploading ? t("mobile.entry.uploading") : t("mobile.entry.retry")}
              </Button>
              <button
                type="button"
                onClick={() => navigate("/m/rooms")}
                className="text-muted-foreground text-xs underline"
              >
                {t("mobile.entry.continueWithout")}
              </button>
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

  return (
    <Form method="post" className="flex flex-col gap-4 p-4">
      <h1 className="font-mono text-lg">{t("mobile.entry.title")}</h1>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t("mobile.entry.room")}</span>
        <select
          name="roomId"
          defaultValue=""
          className="border-input bg-background h-11 rounded-sm border px-3 text-base"
        >
          <option value="">{t("mobile.entry.roomPlaceholder")}</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t("mobile.entry.equipment")}</span>
        <select
          name="equipmentId"
          defaultValue=""
          className="border-input bg-background h-11 rounded-sm border px-3 text-base"
        >
          <option value="">{t("tickets.form.noEquipment")}</option>
          {equipment.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t("mobile.entry.type")}</span>
        <select
          name="type"
          defaultValue={TicketType.INCIDENT}
          className="border-input bg-background h-11 rounded-sm border px-3 text-base"
        >
          {Object.values(TicketType).map((type) => (
            <option key={type} value={type}>
              {ticketTypeLabel(locale, type)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t("mobile.entry.what")}</span>
        <input
          name="title"
          required
          placeholder={t("mobile.entry.whatPlaceholder")}
          className="border-input bg-background h-11 rounded-sm border px-3 text-base"
        />
      </label>
      {fieldErrors?.title ? (
        <p className="text-destructive text-xs">{fieldErrors.title[0]}</p>
      ) : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t("mobile.entry.details")}</span>
        <textarea
          name="description"
          rows={3}
          placeholder={t("mobile.entry.detailsPlaceholder")}
          className="border-input bg-background rounded-sm border px-3 py-2 text-base"
        />
      </label>

      {/* Camera capture — photos ride along after the ticket is created. */}
      <div>
        <span className="text-muted-foreground text-sm">{t("mobile.entry.photo")}</span>
        <div className="mt-1">
          <MobilePhotoCapture
            onCapture={(f) => setPendingPhotos((p) => [...p, f])}
            existingCount={0}
          />
        </div>
      </div>

      <details className="border-border border-t pt-3">
        <summary className="text-muted-foreground cursor-pointer text-sm">
          {t("mobile.entry.alreadyDone")}
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              onChange={(e) => {
                const hidden = document.querySelector<HTMLInputElement>('input[name="status"]');
                if (hidden)
                  hidden.value = e.target.checked ? TicketStatus.RESOLVED : TicketStatus.OPEN;
              }}
            />
            {t("mobile.entry.doneLog")}
          </label>
          <input type="hidden" name="status" value={TicketStatus.OPEN} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("mobile.entry.resolution")}</span>
            <textarea
              name="resolution"
              rows={2}
              className="border-input bg-background rounded-sm border px-3 py-2 text-base"
            />
          </label>
        </div>
      </details>

      <Button type="submit" disabled={busy} className="h-12 text-base">
        {busy ? t("mobile.entry.submitting") : t("mobile.entry.submit")}
      </Button>
    </Form>
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

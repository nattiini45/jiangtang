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

  return (
    <Form method="post" className="flex flex-col gap-4 px-4 py-4">
      <h1 className="text-lg font-semibold">{t("mobile.entry.title")}</h1>

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
              onChange={(e) => {
                const hidden = document.querySelector<HTMLInputElement>('input[name="status"]');
                if (hidden)
                  hidden.value = e.target.checked ? TicketStatus.RESOLVED : TicketStatus.OPEN;
              }}
            />
            {t("mobile.entry.doneLog")}
          </Label>
          <input type="hidden" name="status" value={TicketStatus.OPEN} />
          <Label className="flex flex-col gap-1.5">
            <span>{t("mobile.entry.resolution")}</span>
            <Textarea name="resolution" rows={2} />
          </Label>
        </div>
      </details>

      <Button type="submit" disabled={busy} className="h-12 w-full">
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

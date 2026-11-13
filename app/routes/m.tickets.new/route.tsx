import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { assertCaptureOwner } from "~/lib/pwa/capture-owner.server";
import { formDataToObject } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { resolveLocale } from "~/i18n/locale.server";
import { t as translate } from "~/i18n";
import { useT } from "~/i18n/use-t";
import { getFunctionStates } from "~/domains/functions/functions.queries.server";
import { listTicketTargets } from "~/domains/tickets/tickets.queries.server";
import { ticketCreateSchema } from "~/domains/tickets/tickets.schema";
import { createTicket } from "~/domains/tickets/tickets.mutations.server";
import { useCaptureSubmit } from "~/components/mobile/capture-form";
import { MobilePhotoCapture } from "~/components/mobile/mobile-photo-capture";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const [targets, functions] = await Promise.all([listTicketTargets(), getFunctionStates()]);
  const roomId = new URL(request.url).searchParams.get("roomId") ?? "";
  return { rooms: targets.rooms, functions, roomId };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  assertCaptureOwner(request, actor);
  const locale = resolveLocale(request);
  try {
    const { clientId, ...raw } = formDataToObject(await request.formData());
    const functions = await getFunctionStates({ roomIds: [String(raw.roomId ?? "")] });
    const selected = functions.find((row) => row.functionId === raw.functionId);
    if (!selected || (raw.impact !== "DOWN" && raw.impact !== "LIMITED"))
      throw new ValidationError({}, [translate(locale, "functions.error.required")]);
    const input = ticketCreateSchema.parse({
      ...raw,
      type: "INCIDENT",
      status: "OPEN",
      channel: "PHONE",
      title:
        String(raw.title ?? "").trim() ||
        translate(locale, "functions.faultTitle", {
          function: selected.name,
          impact: translate(locale, `functions.state.${raw.impact}`),
        }),
    });
    const ticket = await createTicket(
      actor,
      input,
      typeof clientId === "string" ? clientId : undefined,
    );
    await emitChange({ entityType: "ticket", id: ticket.id, op: "created" });
    return Response.json({ id: ticket.id });
  } catch (error) {
    if (error instanceof ValidationError)
      return Response.json(
        { error: [...error.formErrors, ...Object.values(error.fieldErrors).flat()].join(" · ") },
        { status: 422 },
      );
    throw toErrorResponse(error);
  }
}

export default function ReportFault({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const navigate = useNavigate();
  const [roomId, setRoomId] = useState(loaderData.roomId);
  const [functionId, setFunctionId] = useState("");
  const [impact, setImpact] = useState("");
  const [query, setQuery] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [offline, setOffline] = useState(false);
  const { state, error, submit } = useCaptureSubmit("/m/tickets/new");
  const functions = loaderData.functions.filter((row) => row.roomId === roomId);
  const selected = functions.find((row) => row.functionId === functionId);
  const room = loaderData.rooms.find((row) => row.id === roomId);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const upload = async (id: string) => {
    setUploading(true);
    const failed: File[] = [];
    for (const photo of photos) {
      const data = new FormData();
      data.set("file", photo);
      data.set("ticketId", id);
      data.set("category", "TICKET");
      data.set("redirectTo", `/m/tickets/${id}`);
      try {
        const response = await fetch("/attachments/upload", { method: "POST", body: data });
        if (!response.ok || new URL(response.url).searchParams.has("uploadError"))
          failed.push(photo);
      } catch {
        failed.push(photo);
      }
    }
    setUploading(false);
    if (!failed.length) {
      void navigate(`/m/rooms/${selected!.roomSlug}#function-${functionId}`);
      return;
    }
    setPhotos(failed);
    setUploadError(true);
  };

  if (savedId)
    return (
      <div className="flex flex-col gap-4 p-4">
        <p role="status">{t("functions.saved")}</p>
        {uploadError ? (
          <>
            <p role="alert" className="text-destructive">
              {t("mobile.entry.uploadFailed", { failed: photos.length, total: photos.length })}
            </p>
            <Button disabled={uploading} onClick={() => void upload(savedId)} className="min-h-11">
              {t("mobile.entry.retry")}
            </Button>
            <Link to={`/m/rooms/${selected!.roomSlug}`}>{t("functions.back")}</Link>
          </>
        ) : (
          <p>{t("mobile.entry.uploading")}</p>
        )}
      </div>
    );

  return (
    <form
      method="post"
      className="flex min-w-0 flex-col gap-4 p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (offline) return;
        const result = await submit(event.currentTarget, { queue: false });
        if (result?.state === "sent" && result.id) {
          setSavedId(result.id);
          void upload(result.id);
        }
      }}
    >
      <h1 className="text-lg font-bold">{t("functions.report")}</h1>
      {!loaderData.roomId ? (
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("mobile.entry.roomPlaceholder")}
          placeholder={t("mobile.entry.roomPlaceholder")}
          className="min-h-11"
        />
      ) : null}
      <Label className="flex flex-col gap-1.5">
        <span>{t("mobile.entry.room")}</span>
        <Select
          name="roomId"
          required
          value={roomId}
          onChange={(event) => {
            setRoomId(event.target.value);
            setFunctionId("");
          }}
          className="[&>select]:h-11"
        >
          <option value="">{t("mobile.entry.roomPlaceholder")}</option>
          {loaderData.rooms
            .filter(
              (row) => row.id === roomId || row.name.toLowerCase().includes(query.toLowerCase()),
            )
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
        </Select>
      </Label>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">{t("functions.choose")}</legend>
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
          {functions.map((row) => (
            <Label
              key={row.functionId}
              className="has-checked:bg-selected bg-card shadow-surface-2 flex min-h-14 min-w-0 items-center gap-2 rounded-md p-3 text-sm"
            >
              <input
                type="radio"
                name="functionId"
                value={row.functionId}
                checked={functionId === row.functionId}
                onChange={() => setFunctionId(row.functionId)}
                required
                className="accent-(--fluid-accent)"
              />
              <span className="min-w-0 break-words">{row.name}</span>
            </Label>
          ))}
        </div>
        {room && !functions.length ? (
          <p className="text-sm text-muted-foreground">{t("functions.empty")}</p>
        ) : null}
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t("functions.impact")}</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["DOWN", "LIMITED"] as const).map((value) => (
            <Label
              key={value}
              className="has-checked:bg-selected bg-card shadow-surface-2 flex min-h-12 items-center gap-2 rounded-md p-3 text-sm"
            >
              <input
                type="radio"
                name="impact"
                value={value}
                checked={impact === value}
                onChange={() => setImpact(value)}
                required
                className="accent-(--fluid-accent)"
              />
              {t(`functions.state.${value}`)}
            </Label>
          ))}
        </div>
      </fieldset>
      <Label className="flex flex-col gap-1.5">
        <span>{t("functions.note")}</span>
        <Textarea name="description" rows={2} />
      </Label>
      <details>
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">
          {t("functions.optional")}
        </summary>
        <div className="flex flex-col gap-3 py-2">
          <Label className="flex flex-col gap-1.5">
            <span>{t("mobile.entry.what")}</span>
            <Input name="title" className="min-h-11" />
          </Label>
          <MobilePhotoCapture
            onCapture={(file) => setPhotos((current) => [...current, file])}
            existingCount={0}
          />
          <Label className="flex flex-col gap-1.5">
            <span>{t("mobile.entry.equipment")}</span>
            <Select key={functionId} name="equipmentId" className="[&>select]:h-11">
              <option value="">{t("tickets.form.noEquipment")}</option>
              {selected?.devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </Select>
          </Label>
        </div>
      </details>
      {offline || state === "unsent" || state === "unsentSignin" ? (
        <p role="alert" className="text-sm">
          {t("functions.offline")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={offline || state === "sending" || !selected || !impact}
        className="min-h-12 w-full"
      >
        {state === "sending" ? t("mobile.entry.submitting") : t("mobile.entry.submit")}
      </Button>
    </form>
  );
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";

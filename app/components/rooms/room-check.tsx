import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { Button } from "@ui-sdk/react/button";
import { Textarea } from "@ui-sdk/react/textarea";
import { useT } from "~/i18n/use-t";
import { buttonVariants } from "~/components/ui/button";
import { fieldClassName } from "~/components/ui/input";
import { KnownFixes } from "~/components/rooms/room-functions";
import { RoundChoice } from "./round-pages";
import { MobilePhotoCapture } from "~/components/mobile/mobile-photo-capture";
import type { RoomFunctionState } from "~/domains/functions/functions.queries.server";
import type { getRound } from "~/domains/functions/rounds.queries.server";
import type { RoomCheck } from "~/generated/prisma/client";

export function RoomCheckPage({
  round,
  room,
  functions,
  checks,
}: {
  round: NonNullable<Awaited<ReturnType<typeof getRound>>>;
  room: { id: string; slug: string; name: string };
  functions: RoomFunctionState[];
  checks: RoomCheck[];
}) {
  const t = useT();
  const finish = useFetcher<{ error?: string }>();
  const next = round.rooms.find((row) => !row.completedAt && row.roomId !== room.id);
  return (
    <div className="flex min-w-0 flex-col gap-5 p-4">
      <Link to={`/m/rounds/${round.id}`} className="text-sm underline underline-offset-4">
        {round.name}
      </Link>
      <h1 className="break-words text-xl font-bold">{room.name}</h1>
      <p className="text-sm nums">
        {t("functions.rounds.progress", { done: round.done, total: round.rooms.length })}
      </p>
      {functions.map((row) => (
        <CheckFunction
          key={`${round.id}:${room.id}:${row.functionId}`}
          row={row}
          roundId={round.id}
          check={checks.find(
            (check) => check.functionId === row.functionId && check.result !== "NOT_CHECKED",
          )}
        />
      ))}
      {!functions.some(
        (row) => row.hasCarrier || row.faults.some((fault) => fault.functionId === row.functionId),
      ) ? (
        <finish.Form method="post" className="flex flex-col gap-3">
          <p>{t("functions.rounds.emptyChecklist")}</p>
          {finish.data?.error ? <p role="alert">{finish.data.error}</p> : null}
          <Button
            type="submit"
            name="intent"
            value="finishEmpty"
            className={`${buttonVariants()} min-h-11 self-start`}
            disabled={finish.state !== "idle"}
          >
            {t("functions.rounds.finishEmpty")}
          </Button>
        </finish.Form>
      ) : null}
      {next ? (
        <Link
          className={`${buttonVariants()} min-h-11`}
          to={`/m/rounds/${round.id}/${next.roomId}`}
        >
          {t("functions.rounds.next")}
        </Link>
      ) : null}
      <Link
        className="min-h-11 py-3 text-sm underline underline-offset-4"
        to={`/m/rooms/${room.slug}`}
      >
        {t("functions.back")}
      </Link>
    </div>
  );
}

function CheckFunction({
  row,
  roundId,
  check,
}: {
  row: RoomFunctionState;
  roundId: string;
  check?: RoomCheck;
}) {
  const t = useT();
  const fetcher = useFetcher<{ check?: RoomCheck; error?: string }>();
  const [worksPrompt, setWorksPrompt] = useState(false);
  const [photos, setPhotos] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [offline, setOffline] = useState(false);
  const uploaded = useRef<string | null>(null);
  const current =
    fetcher.data?.check?.result !== "NOT_CHECKED" ? (fetcher.data?.check ?? check) : check;
  const unhealthy = row.devices.filter((device) => device.status !== "OPERATIONAL");
  const conflict = row.faults.length > 0 || unhealthy.length > 0;
  const upload = async (saved: RoomCheck, files: File[]) => {
    setUploading(true);
    setUploadError(false);
    const remaining: File[] = [];
    for (const file of files) {
      const form = new FormData();
      form.set("file", file);
      const failed = saved.result === "DOWN" || saved.result === "LIMITED";
      form.set(failed ? "ticketId" : "roomId", failed ? saved.ticketId! : row.roomId);
      form.set("category", failed ? "TICKET" : "ROOM");
      form.set("redirectTo", `/m/rounds/${roundId}/${row.roomId}`);
      try {
        const response = await fetch("/attachments/upload", { method: "POST", body: form });
        if (!response.ok || new URL(response.url).searchParams.has("uploadError"))
          throw new Error();
      } catch {
        remaining.push(file);
      }
    }
    setPhotos(remaining);
    setUploadError(remaining.length > 0);
    setUploading(false);
  };
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
  useEffect(() => {
    if (
      fetcher.data?.check &&
      fetcher.data.check.result !== "NOT_CHECKED" &&
      photos.length &&
      uploaded.current !== fetcher.data.check.id
    ) {
      uploaded.current = fetcher.data.check.id;
      void upload(fetcher.data.check, photos);
    }
  });
  return (
    <section
      className="bg-card shadow-surface-2 min-w-0 rounded-lg p-3"
      aria-labelledby={`check-${row.functionId}`}
    >
      <h2 id={`check-${row.functionId}`} className="text-base font-semibold">
        {row.name}
      </h2>
      {row.state === "MISSING" ? (
        <p className="my-2 text-sm text-muted-foreground">{t("functions.missing")}</p>
      ) : null}
      <p className="my-2 text-xs text-muted-foreground">
        {row.devices.map((device) => device.name).join(" · ")}
      </p>
      {!row.hasCarrier && !row.faults.some((fault) => fault.functionId === row.functionId) ? (
        <p className="text-sm text-muted-foreground">{t("functions.rounds.noCarrier")}</p>
      ) : current ? (
        <p role="status" className="text-sm font-semibold">
          {t("functions.rounds.saved")} · {t(`functions.state.${current.result}`)}
        </p>
      ) : (
        <fetcher.Form
          method="post"
          aria-labelledby={`check-${row.functionId}`}
          action={`/m/rounds/${roundId}/${row.roomId}`}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            if (offline) event.preventDefault();
          }}
        >
          <input type="hidden" name="functionId" value={row.functionId} />
          <KnownFixes fixes={row.knownFixes} expanded />
          <details>
            <summary className="min-h-11 cursor-pointer py-3 text-sm underline underline-offset-4">
              {t("functions.rounds.notePhoto")}
            </summary>
            <label className="flex flex-col gap-1 text-sm">
              {t("functions.note")}
              <Textarea name="note" rows={2} maxLength={5000} className={`${fieldClassName} p-3`} />
            </label>
            <MobilePhotoCapture
              onCapture={(file) => setPhotos((current) => [...current, file])}
              existingCount={photos.length}
            />
            <Button
              type="submit"
              name="result"
              value="NOT_CHECKED"
              className={`${buttonVariants({ variant: "tertiary" })} min-h-11`}
              disabled={offline || fetcher.state !== "idle"}
            >
              {t("functions.state.NOT_CHECKED")}
            </Button>
          </details>
          {worksPrompt ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">{t("functions.rounds.conflict")}</p>
              {row.faults.map((fault) => (
                <RoundChoice key={fault.id} name="resolveFaults" value={fault.id}>
                  {t("functions.rounds.resolve", { title: fault.title })}
                </RoundChoice>
              ))}
              {row.faults.length ? (
                <label className="flex flex-col gap-1 text-sm">
                  {t("functions.fixes.helped")}
                  <Textarea
                    name="resolution"
                    rows={2}
                    maxLength={5000}
                    className={`${fieldClassName} p-3`}
                  />
                </label>
              ) : null}
              {unhealthy.map((device) => (
                <RoundChoice key={device.id} name="restoreDevices" value={device.id}>
                  {t("functions.rounds.restore", { name: device.name })}
                </RoundChoice>
              ))}
              <Button
                type="submit"
                name="result"
                value="WORKS"
                className={`${buttonVariants()} min-h-11`}
                disabled={offline || fetcher.state !== "idle"}
              >
                {t("common.save")}
              </Button>
            </div>
          ) : null}
          <div className="grid grid-cols-3 gap-2">
            {(["WORKS", "LIMITED", "DOWN"] as const).map((result) => (
              <Button
                key={result}
                type="submit"
                name="result"
                value={result}
                onClick={(event) => {
                  if (result === "WORKS" && conflict) {
                    event.preventDefault();
                    setWorksPrompt(true);
                  }
                }}
                disabled={offline || fetcher.state !== "idle"}
                className={`${buttonVariants({ variant: "secondary" })} min-h-12 h-auto px-1 py-3 text-center break-normal whitespace-normal`}
              >
                {t(`functions.state.${result}`)}
              </Button>
            ))}
          </div>
          {fetcher.data?.error ? (
            <p role="alert" className="text-sm text-destructive">
              {fetcher.data.error}
            </p>
          ) : null}
          {offline ? (
            <p role="alert" className="text-sm">
              {t("functions.rounds.offline")}
            </p>
          ) : null}
        </fetcher.Form>
      )}
      {uploading ? (
        <p role="status" className="text-sm">
          {t("mobile.entry.uploading")}
        </p>
      ) : null}
      {uploadError && current && photos.length ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {t("functions.rounds.photoFailed")}
          </p>
          <Button
            className={`${buttonVariants({ variant: "secondary" })} min-h-11`}
            onClick={() => upload(current, photos)}
            disabled={uploading}
          >
            {t("mobile.entry.retry")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

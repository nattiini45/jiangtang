import { Link, useFetcher, useRouteLoaderData } from "react-router";
import { FunctionStateDialog } from "./function-state-dialog";
import type { RoomFunctionState } from "~/domains/functions/functions.queries.server";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDate, formatDateTime } from "~/i18n/format";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { ViewSwitch } from "~/components/layout/view-switch";
import { StatusBadge } from "~/components/ui/status-badge";
import { toneClassName, toneDotClassName } from "~/lib/status";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import { Select } from "~/components/ui/select";

export function RoomFunctions({
  functions,
  roomId,
  roomStatus,
  mobile = false,
  roomSlug,
  knownIssues,
  fixFunctions = functions.map((row) => ({ id: row.functionId, name: row.name })),
}: {
  functions: RoomFunctionState[];
  roomId: string;
  roomStatus: string;
  mobile?: boolean;
  roomSlug?: string;
  knownIssues?: string | null;
  fixFunctions?: { id: string; name: string }[];
}) {
  const t = useT();
  const locale = useLocale();
  const desktop = useRouteLoaderData<{ user: { role: string } }>("routes/_desktop");
  const phone = useRouteLoaderData<{ user: { role: string } }>("routes/m");
  const admin = (desktop ?? phone)?.user.role === "ADMIN";
  return (
    <section className="min-w-0" aria-labelledby="room-functions-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="room-functions-title" className="text-base font-semibold">
          {t("functions.title")}
        </h2>
        {mobile ? (
          <Button asChild variant="secondary" className="min-h-11">
            <Link to={`/m/tickets/new?roomId=${roomId}`}>{t("functions.report")}</Link>
          </Button>
        ) : (
          <ViewSwitch
            view="mobile"
            next={`/m/tickets/new?roomId=${roomId}`}
            className={buttonVariants({ variant: "secondary" })}
          >
            {t("functions.report")}
          </ViewSwitch>
        )}
      </div>
      {roomStatus === "ALL_GOOD" && functions.some((row) => row.state === "DOWN") ? (
        <p className="mb-3 text-sm text-muted-foreground">{t("functions.roomHint")}</p>
      ) : null}
      {!functions.length ? (
        <p className="text-sm text-muted-foreground">{t("functions.empty")}</p>
      ) : (
        <ul className="bg-card shadow-surface-2 divide-y rounded-lg">
          {functions.map((row) => {
            const tone =
              row.state === "DOWN"
                ? "fault"
                : row.state === "LIMITED"
                  ? "warning"
                  : row.state === "WORKS"
                    ? "operational"
                    : "neutral";
            return (
              <li
                key={row.functionId}
                id={`function-${row.functionId}`}
                className="flex min-w-0 scroll-mt-20 flex-col gap-2 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={row.name}>
                    {row.name}
                  </h3>
                  <Badge className={toneClassName(tone)}>
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${toneDotClassName(tone)}`}
                    />
                    {t(`functions.state.${row.state}`)}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {row.state === "MISSING"
                    ? t("functions.missing")
                    : row.manualReason
                      ? t("functions.manual", { reason: row.manualReason })
                      : row.state === "WORKS" && row.lastCheckedAt
                        ? t("functions.confirmed", {
                            date: formatDateTime(locale, row.lastCheckedAt),
                          })
                        : row.causes.length
                          ? row.since
                            ? t("functions.since", { date: formatDateTime(locale, row.since) })
                            : t("functions.before", {
                                date: formatDate(locale, "2026-11-13T00:00:00Z"),
                              })
                          : t("functions.never")}
                </p>
                {row.expectationNote ? (
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {row.expectationNote}
                  </p>
                ) : null}
                {row.causes.map((cause, index) => {
                  const fault = row.faults.find((fault) => fault.id === cause.ticketId);
                  const device = row.devices.find((device) => device.id === cause.deviceId);
                  return (
                    <p
                      key={index}
                      className="truncate text-sm"
                      title={fault?.title ?? device?.name}
                    >
                      {fault ? (
                        <Link
                          className="underline underline-offset-4"
                          to={`${mobile ? "/m" : ""}/tickets/${fault.id}`}
                        >
                          {fault.title}
                        </Link>
                      ) : (
                        device?.name
                      )}
                    </p>
                  );
                })}
                <div className="flex min-w-0 flex-wrap gap-2">
                  {row.devices.map((device) => (
                    <span key={device.id} className="flex max-w-full items-center gap-1.5 text-xs">
                      <span className="min-w-0 truncate" title={device.name}>
                        {device.name}
                      </span>
                      <StatusBadge kind="equipment" value={device.status} />
                    </span>
                  ))}
                </div>
                <KnownFixes fixes={row.knownFixes} roomSlug={roomSlug} />
                {admin ? <FunctionStateDialog roomId={roomId} functionId={row.functionId} /> : null}
              </li>
            );
          })}
        </ul>
      )}
      {knownIssues && roomSlug ? (
        <EarlierNote note={knownIssues} roomSlug={roomSlug} functions={fixFunctions} />
      ) : null}
    </section>
  );
}

export function KnownFixes({
  fixes,
  roomSlug,
  expanded = false,
}: {
  fixes: RoomFunctionState["knownFixes"];
  roomSlug?: string;
  expanded?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  if (!fixes.length) return null;
  return (
    <details open={expanded || undefined} className="min-w-0">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">
        {t("functions.fixes.count", { count: fixes.length })}
      </summary>
      <ul className="divide-y">
        {fixes.map((fix) => (
          <li key={fix.id} className="min-w-0 space-y-2 py-3 text-sm [overflow-wrap:anywhere]">
            <p className="font-semibold">{fix.title}</p>
            <p className="whitespace-pre-wrap">{fix.resolution}</p>
            {fix.resolvedAt ? (
              <p className="text-xs text-muted-foreground nums">
                {formatDateTime(locale, fix.resolvedAt)}
              </p>
            ) : null}
            {roomSlug ? <FixEditor fix={fix} roomSlug={roomSlug} /> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function FixEditor({
  fix,
  roomSlug,
}: {
  fix: RoomFunctionState["knownFixes"][number];
  roomSlug: string;
}) {
  const t = useT();
  const fetcher = useFetcher<{ error?: string }>();
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-3 text-sm underline underline-offset-4">
        {t("functions.fixes.edit")}
      </summary>
      <fetcher.Form
        method="post"
        action={`/rooms/${roomSlug}/fixes`}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="id" value={fix.id} />
        <Label htmlFor={`fix-title-${fix.id}`}>{t("functions.fixes.problem")}</Label>
        <Input id={`fix-title-${fix.id}`} name="title" defaultValue={fix.title} required />
        <Label htmlFor={`fix-resolution-${fix.id}`}>{t("functions.fixes.helped")}</Label>
        <Textarea
          id={`fix-resolution-${fix.id}`}
          name="resolution"
          defaultValue={fix.resolution ?? ""}
          rows={2}
          required
        />
        {fetcher.data?.error ? (
          <p role="alert" className="text-destructive text-sm">
            {fetcher.data.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            name="intent"
            value="edit"
            disabled={fetcher.state !== "idle"}
            className="min-h-11"
          >
            {t("common.save")}
          </Button>
          <Button
            name="intent"
            value="drop"
            variant="secondary"
            formNoValidate
            className="min-h-11"
            disabled={fetcher.state !== "idle"}
          >
            {t("functions.fixes.drop")}
          </Button>
        </div>
      </fetcher.Form>
    </details>
  );
}

function EarlierNote({
  note,
  roomSlug,
  functions,
}: {
  note: string;
  roomSlug: string;
  functions: { id: string; name: string }[];
}) {
  const t = useT();
  const fetcher = useFetcher<{ error?: string }>();
  return (
    <details className="mt-3">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">
        {t("functions.fixes.earlierNote")}
      </summary>
      <p className="mb-3 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{note}</p>
      <fetcher.Form
        method="post"
        action={`/rooms/${roomSlug}/fixes`}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="intent" value="move" />
        <input type="hidden" name="note" value={note} />
        <Label className="flex flex-col gap-1.5">
          {t("functions.list.function")}
          <Select name="functionId" defaultValue="" required>
            <option value="">{t("functions.choose")}</option>
            {functions.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </Select>
        </Label>
        <p className="text-xs text-muted-foreground">{t("functions.fixes.moveHelp")}</p>
        {fetcher.data?.error ? (
          <p role="alert" className="text-destructive text-sm">
            {fetcher.data.error}
          </p>
        ) : null}
        <Button
          disabled={fetcher.state !== "idle" || !functions.length}
          className="self-start min-h-11"
        >
          {t("functions.fixes.move")}
        </Button>
      </fetcher.Form>
    </details>
  );
}

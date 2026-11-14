import { Link, useFetcher, useSearchParams } from "react-router";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { NumberInput, NumberInputGroup, NumberInputControl } from "@ui-sdk/react/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { ChevronDown } from "lucide-react";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDateTime, formatNumber } from "~/i18n/format";
import { buttonVariants } from "~/components/ui/button";
import { fieldClassName } from "~/components/ui/input";
import type {
  ReadingDevice,
  getDeviceReadings,
  dueReadings,
} from "~/domains/readings/readings.queries.server";

const CONTROL = `${fieldClassName} h-control px-control min-h-12 text-base sm:min-h-control sm:text-sm`;
const LINK = "min-w-0 break-words text-sm underline underline-offset-4";

export function ReadingState({ measure }: { measure: ReadingDevice["measures"][number] }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="space-y-1 text-sm">
      <p className="nums">
        <span className="font-semibold">
          {measure.latest
            ? typeof measure.latest.value === "number"
              ? formatNumber(locale, measure.latest.value, { maximumFractionDigits: 6 })
              : typeof measure.latest.value === "boolean"
                ? t(measure.latest.value ? "readings.yes" : "readings.no")
                : measure.latest.display
            : t("readings.none")}
        </span>
        {measure.latest && measure.unit ? ` ${measure.unit}` : ""}
        {measure.limit
          ? t(measure.latest ? "readings.against" : "readings.rated", {
              limit: formatNumber(locale, measure.limit),
              unit: measure.unit ?? "",
            })
          : null}
        {measure.serviceCounter ? <> · {t(`readings.state.${measure.state}`)}</> : null}
      </p>
      {measure.latest ? (
        <p className="text-xs text-muted-foreground">
          {t("readings.observed", {
            date: formatDateTime(locale, measure.latest.observedAt),
            days: measure.age ?? 0,
          })}
          {" · "}
          {t(
            `readings.source.${measure.latest.source as "typed" | "round" | "replacement" | "network"}`,
          )}
        </p>
      ) : null}
      {measure.stale ? (
        <p className="text-sm font-semibold">
          {t(measure.serviceCounter ? "readings.stale" : "readings.old")}
        </p>
      ) : null}
    </div>
  );
}

function ReadingForm({
  device,
  measure,
  action,
  roundId,
}: {
  device: ReadingDevice;
  measure: ReadingDevice["measures"][number];
  action: string;
  roundId?: string;
}) {
  const t = useT();
  const fetcher = useFetcher<{ readingSaved?: boolean; readingError?: string }>();
  const Heading = roundId ? "h4" : "h3";
  const items =
    measure.type === "BOOLEAN"
      ? [
          { value: "true", label: t("readings.yes") },
          { value: "false", label: t("readings.no") },
        ]
      : measure.options;
  return (
    <Collapsible className="py-3" data-reading-measure={measure.key}>
      <div className="flex items-center justify-between gap-2">
        <Heading className="min-w-0 flex-1 break-words text-sm font-semibold">
          {measure.name}
        </Heading>
        <CollapsibleTrigger
          type="button"
          aria-label={`${t("readings.enter")} · ${measure.name}`}
          className={`${buttonVariants({ variant: "secondary" })} min-h-12 sm:min-h-control`}
        >
          {t("readings.enter")}
          <ChevronDown aria-hidden className="size-icon" />
        </CollapsibleTrigger>
      </div>
      <ReadingState measure={measure} />
      <CollapsiblePanel className="pt-3">
        <fetcher.Form
          method="post"
          action={action}
          aria-label={`${device.name} · ${measure.name}`}
          className="flex flex-col gap-3"
        >
          <input type="hidden" name="intent" value="reading" />
          <input type="hidden" name="equipmentId" value={device.id} />
          <input type="hidden" name="fieldId" value={measure.id} />
          {roundId ? <input type="hidden" name="roundId" value={roundId} /> : null}
          <Field name="value" className="flex flex-col gap-1">
            <FieldLabel className="text-sm">
              {measure.unit
                ? t("readings.value", { measure: measure.name, unit: measure.unit })
                : measure.name}
            </FieldLabel>
            {items.length ? (
              <Select name="value" items={items} required>
                <SelectTrigger className={CONTROL}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-popover shadow-surface-3 z-50 max-h-72 overflow-auto rounded-lg p-1">
                  {items.map((item) => (
                    <SelectItem
                      key={item.value}
                      value={item.value}
                      className="data-highlighted:bg-hover data-selected:bg-selected px-3 py-2 text-sm"
                    >
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : measure.type === "NUMBER" ? (
              <NumberInput name="value" step={0.000001} required>
                <NumberInputGroup>
                  <NumberInputControl className={CONTROL} inputMode="decimal" />
                </NumberInputGroup>
              </NumberInput>
            ) : (
              <Input
                name="value"
                type={measure.type === "DATE" ? "date" : "text"}
                required
                className={CONTROL}
              />
            )}
          </Field>
          <Field name="observedAt" className="flex flex-col gap-1">
            <FieldLabel className="text-sm">{t("readings.when")}</FieldLabel>
            <Input
              type="datetime-local"
              step="0.001"
              name="observedAt"
              required
              defaultValue={device.localNow}
              className={CONTROL}
            />
          </Field>
          {fetcher.data?.readingError ? (
            <p role="alert" className="text-sm text-destructive">
              {fetcher.data.readingError}
            </p>
          ) : null}
          {fetcher.data?.readingSaved && fetcher.state === "idle" ? (
            <p role="status" className="text-sm">
              {t("readings.saved")}
            </p>
          ) : null}
          <Button
            type="submit"
            aria-label={`${t("readings.save")} · ${measure.name}`}
            disabled={fetcher.state !== "idle"}
            className={`${buttonVariants()} min-h-12 self-start sm:min-h-control`}
          >
            {t("readings.save")}
          </Button>
        </fetcher.Form>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function DeviceReadings({
  device,
  action,
  roundId,
  summary = false,
}: {
  device: ReadingDevice;
  action: string;
  roundId?: string;
  summary?: boolean;
}) {
  const t = useT();
  const Heading = roundId ? "h3" : "h2";
  return (
    <section
      aria-label={t("readings.title")}
      className="min-w-0 rounded-lg bg-card p-4 shadow-surface-2"
    >
      <Heading className="break-words text-base font-semibold">
        {roundId ? device.name : t("readings.title")}
      </Heading>
      <div className="divide-y">
        {device.measures
          .filter((measure) => !summary || measure.latest)
          .map((measure) =>
            summary || device.retired ? (
              <div key={measure.id} className="py-2">
                <h3 className="text-sm font-semibold">{measure.name}</h3>
                <ReadingState measure={measure} />
              </div>
            ) : (
              <ReadingForm
                key={measure.id}
                device={device}
                measure={measure}
                action={action}
                roundId={roundId}
              />
            ),
          )}
      </div>
      <Link
        className={`${LINK} inline-flex min-h-12 items-center`}
        to={`${roundId ? `/m/inventory/${device.id}/readings` : action}?history=1`}
      >
        {t(summary ? "readings.enterAndHistory" : "readings.history")}
      </Link>
    </section>
  );
}

export function ReadingDueRows({
  rows,
  mobile = false,
}: {
  rows: Awaited<ReturnType<typeof dueReadings>>;
  mobile?: boolean;
}) {
  return (
    <ul className="divide-y">
      {rows.map((row) => (
        <li key={`${row.deviceId}:${row.id}`} className="py-3">
          <Link to={`${mobile ? "/m" : ""}/inventory/${row.deviceId}/readings`} className={LINK}>
            {[row.room?.name, row.device, row.name].filter(Boolean).join(" · ")}
          </Link>
          <ReadingState measure={row} />
          <ReadingParts parts={row.parts} />
        </li>
      ))}
    </ul>
  );
}

export function RoundReadings({
  devices,
  roundId,
  roomId,
}: {
  devices: ReadingDevice[];
  roundId: string;
  roomId: string;
}) {
  const t = useT();
  return devices.length ? (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">{t("readings.title")}</h2>
      {devices.map((device) => (
        <Collapsible key={device.id}>
          <CollapsibleTrigger
            type="button"
            className={`${buttonVariants({ variant: "secondary" })} min-h-12 w-full justify-between whitespace-normal text-start`}
          >
            <span className="min-w-0 break-words">{device.name}</span>
            <ChevronDown aria-hidden className="size-icon shrink-0" />
          </CollapsibleTrigger>
          <CollapsiblePanel className="pt-3">
            <DeviceReadings
              device={device}
              action={`/m/rounds/${roundId}/${roomId}`}
              roundId={roundId}
            />
          </CollapsiblePanel>
        </Collapsible>
      ))}
    </section>
  ) : null;
}

export function ReadingParts({ parts }: { parts: ReadingDevice["parts"] }) {
  const t = useT();
  return (
    <ul className="mt-2 text-sm text-muted-foreground">
      {parts.map((part) => (
        <li key={part.id} className="break-words">
          {part.name}
          {" · "}
          {t("parts.count", { count: part.count })}
        </li>
      ))}
    </ul>
  );
}

function Replacement({ device, action }: { device: ReadingDevice; action: string }) {
  const t = useT();
  const fetcher = useFetcher<{ readingSaved?: boolean; readingError?: string }>();
  return (
    <section aria-label={t("readings.replace")} className="rounded-lg bg-card p-4 shadow-surface-2">
      <h2 className="text-base font-semibold">{t("readings.replace")}</h2>
      <p className="my-2 text-sm text-muted-foreground">{t("readings.replaceHint")}</p>
      {device.parts.flatMap((part) =>
        part.stock.map((stock) => {
          const source = stock.location?.name ?? stock.name;
          const name = t("readings.stockSource", { part: part.name, source });
          return (
            <fetcher.Form
              key={stock.id}
              action={action}
              method="post"
              className="flex flex-wrap items-center justify-between gap-3 py-2"
              aria-label={name}
            >
              <input type="hidden" name="intent" value="replacePart" />
              <input type="hidden" name="stockId" value={stock.id} />
              <p className="min-w-0 flex-1 break-words text-sm">
                {name}
                {" · "}
                {t("parts.count", { count: stock.quantity })}
              </p>
              <Button
                type="submit"
                aria-label={`${t("readings.install")} · ${name}`}
                data-agent-confirm={t("readings.replaceConfirm", { part: name })}
                disabled={fetcher.state !== "idle"}
                className={`${buttonVariants({ variant: "secondary" })} min-h-12`}
              >
                {t("readings.install")}
              </Button>
            </fetcher.Form>
          );
        }),
      )}
      {fetcher.data?.readingError ? (
        <p role="alert" className="text-sm text-destructive">
          {fetcher.data.readingError}
        </p>
      ) : null}
      {fetcher.data?.readingSaved ? (
        <p role="status" className="text-sm">
          {t("readings.replaced")}
        </p>
      ) : null}
    </section>
  );
}

export function ReadingsPage({
  device,
  history,
  mobile = false,
}: Awaited<ReturnType<typeof getDeviceReadings>> & { mobile?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [params] = useSearchParams();
  const action = `${mobile ? "/m" : ""}/inventory/${device.id}/readings`;
  return (
    <div className={`mx-auto flex max-w-3xl flex-col gap-5 ${mobile ? "p-4" : ""}`}>
      <Link
        className={`${LINK} ${mobile ? "inline-flex min-h-12 items-center" : ""}`}
        to={
          mobile
            ? device.room
              ? `/m/rooms/${device.room.slug}`
              : "/m/due"
            : `/inventory/${device.id}`
        }
      >
        {t("readings.back")}
      </Link>
      <h1 className="break-words text-xl font-bold">{device.name}</h1>
      <ReadingParts parts={device.parts} />
      <DeviceReadings device={device} action={action} />
      {!device.retired && device.parts.some((part) => part.stock.length) ? (
        <Replacement device={device} action={action} />
      ) : null}
      {params.has("history") ? (
        <section
          aria-label={t("readings.history")}
          className="rounded-lg bg-card p-4 shadow-surface-2"
        >
          <h2 className="text-base font-semibold">{t("readings.history")}</h2>
          <p className="text-xs text-muted-foreground">{t("readings.historyLimit")}</p>
          <ul className="divide-y">
            {history.map((entry) => (
              <li key={entry.id} className="py-3 text-sm">
                <p className="break-words">
                  {entry.name}
                  {" · "}
                  {entry.display}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(locale, entry.observedAt)}
                  {" · "}
                  {t(
                    `readings.source.${entry.source as "typed" | "round" | "replacement" | "network"}`,
                  )}
                  {" · "}
                  {entry.recordedBy?.name ?? t("readings.unknownActor")}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

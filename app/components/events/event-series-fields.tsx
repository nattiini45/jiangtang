import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Check, ChevronDown, Repeat2 } from "lucide-react";
import { useFieldError } from "~/components/forms";
import { fieldClassName } from "~/components/ui/input";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDate } from "~/i18n/format";
import { eventStartWeekday } from "~/domains/events/events.time";

const control = `${fieldClassName} h-control px-control`;

export type SeriesResult = { eventIds: string[]; conflicts: { date: string; message: string }[] };

function SeriesField({
  name,
  label,
  children,
}: {
  name: string;
  label: string;
  children: (attributes: { "aria-invalid"?: true; "aria-describedby"?: string }) => React.ReactNode;
}) {
  const error = useFieldError(name);
  const errorId = useId();
  return (
    <Field name={name} invalid={error ? true : undefined} className="min-w-0 space-y-1">
      <FieldLabel className="text-xs font-semibold">{label}</FieldLabel>
      {children(error ? { "aria-invalid": true, "aria-describedby": errorId } : {})}
      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </Field>
  );
}

function SeriesChoice({
  name,
  label,
  options,
  initial,
  onChange,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  initial: string;
  onChange?: (value: string) => void;
}) {
  return (
    <SeriesField name={name} label={label}>
      {(attributes) => (
        <Select
          name={name}
          items={options}
          defaultValue={initial}
          onValueChange={(value) => {
            if (value) onChange?.(value);
          }}
        >
          <SelectTrigger
            {...attributes}
            className={`${control} flex items-center justify-between gap-2`}
          >
            <SelectValue className="min-w-0 truncate" />
            <ChevronDown className="size-icon shrink-0" aria-hidden />
          </SelectTrigger>
          <SelectContent className="bg-popover shadow-surface-3 max-w-(--available-width) min-w-(--anchor-width) rounded-lg p-1">
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                className="data-highlighted:bg-hover data-selected:bg-selected min-h-control cursor-pointer rounded-md px-control py-2 text-sm"
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </SeriesField>
  );
}

export function EventRecurrenceFields({
  start,
  frequency,
  onFrequencyChange,
}: {
  start: string;
  frequency: string;
  onFrequencyChange: (frequency: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [end, setEnd] = useState("date");
  const days = Array.from({ length: 7 }, (_, i) => i + 1);
  const weekday = eventStartWeekday(start);
  const weekdayName = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long" });
  const [uncheckedStartDay, setUncheckedStartDay] = useState<number | null>(null);
  const submittedWeekdaysError = useFieldError("weekdays");
  const weekdaysError = uncheckedStartDay === weekday ? submittedWeekdaysError : undefined;
  const weekdaysErrorId = useId();
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="mb-2 flex items-center gap-2 text-base font-semibold">
        <Repeat2 className="size-icon" aria-hidden /> {t("events.series.schedule")}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <SeriesChoice
          name="frequency"
          label={t("events.series.frequency")}
          initial="once"
          options={[
            { value: "once", label: t("events.series.once") },
            { value: "daily", label: t("events.series.daily") },
            { value: "weekly", label: t("events.series.weekly") },
            { value: "monthly", label: t("events.series.monthly") },
          ]}
          onChange={onFrequencyChange}
        />
        {frequency === "weekly" ? (
          <SeriesField name="interval" label={t("events.series.interval")}>
            {(attributes) => (
              <Input
                {...attributes}
                className={control}
                type="number"
                name="interval"
                min={1}
                max={52}
                required
                defaultValue="1"
              />
            )}
          </SeriesField>
        ) : null}
      </div>
      {frequency === "weekly" ? (
        <fieldset
          aria-describedby={weekdaysError ? weekdaysErrorId : undefined}
          aria-invalid={weekdaysError ? true : undefined}
        >
          <legend className="mb-1 text-xs font-semibold">{t("events.series.weekdays")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {days.map((day) => (
              <label
                key={`${day}:${weekday === day}`}
                className="flex min-h-control cursor-pointer items-center gap-1.5 text-sm"
              >
                <Checkbox
                  name="weekdays"
                  value={String(day)}
                  defaultChecked={weekday === day}
                  onCheckedChange={(checked) => {
                    if (weekday === day) setUncheckedStartDay(checked === true ? null : day);
                  }}
                  className="data-checked:bg-selected flex size-5 shrink-0 items-center justify-center rounded-sm shadow-[inset_0_0_0_1px_var(--input)]"
                >
                  <CheckboxIndicator>
                    <Check className="size-4" aria-hidden />
                  </CheckboxIndicator>
                </Checkbox>
                {weekdayName.format(new Date(Date.UTC(2026, 0, 4 + day)))}
              </label>
            ))}
          </div>
          {weekdaysError ? (
            <p id={weekdaysErrorId} role="alert" className="text-destructive text-xs">
              {weekdaysError}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {frequency !== "once" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <SeriesChoice
              name="endKind"
              label={t("events.series.end")}
              initial={end}
              options={[
                { value: "date", label: t("events.series.byDate") },
                { value: "count", label: t("events.series.byCount") },
              ]}
              onChange={setEnd}
            />
            {end === "date" ? (
              <SeriesField name="endDate" label={t("events.series.lastDate")}>
                {(attributes) => (
                  <Input
                    {...attributes}
                    className={control}
                    type="date"
                    name="endDate"
                    min={start.slice(0, 10)}
                    required
                  />
                )}
              </SeriesField>
            ) : (
              <SeriesField name="count" label={t("events.series.count")}>
                {(attributes) => (
                  <Input
                    {...attributes}
                    className={control}
                    type="number"
                    name="count"
                    min={1}
                    max={1000}
                    required
                    defaultValue="8"
                  />
                )}
              </SeriesField>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            {t(frequency === "monthly" ? "events.series.monthlyHint" : "events.series.hint")}
          </p>
        </>
      ) : null}
    </fieldset>
  );
}

export function EventSeriesScope({
  seriesId,
  cancel = false,
}: {
  seriesId: string;
  cancel?: boolean;
}) {
  const t = useT();
  const [scope, setScope] = useState("one");
  return (
    <div className="max-w-sm space-y-2">
      <input type="hidden" name="seriesId" value={seriesId} />
      <SeriesChoice
        name={cancel ? "cancelScope" : "editScope"}
        label={t(cancel ? "events.series.cancelScope" : "events.series.editScope")}
        initial="one"
        onChange={setScope}
        options={[
          { value: "one", label: t("events.series.one") },
          { value: "following", label: t("events.series.following") },
        ]}
      />
      <p className="text-muted-foreground text-xs">
        {t(
          scope === "following"
            ? cancel
              ? "events.series.cancelFollowingHint"
              : "events.series.editFollowingHint"
            : "events.series.singleHint",
        )}
      </p>
    </div>
  );
}

export function SeriesConflicts({
  dates,
  conflicts,
}: {
  dates: readonly string[];
  conflicts?: SeriesResult["conflicts"];
}) {
  const t = useT();
  const locale = useLocale();
  if (!dates.length) return null;
  const rows = conflicts ?? dates.map((date) => ({ date, message: null }));
  return (
    <div className="space-y-2">
      <p className="font-semibold">{t("events.series.skipped", { count: dates.length })}</p>
      <ul
        className={
          conflicts
            ? "max-h-40 space-y-1 overflow-y-auto"
            : "grid max-h-32 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-4 gap-y-1 overflow-y-auto"
        }
      >
        {rows.map(({ date, message }) => (
          <li key={date}>
            <time dateTime={date}>{formatDate(locale, `${date}T12:00:00Z`)}</time>
            {message ? <span className="text-muted-foreground"> · {message}</span> : null}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">{t("events.series.skippedHint")}</p>
    </div>
  );
}

export function EventSeriesResult({ result }: { result: SeriesResult }) {
  const t = useT();
  const first = result.eventIds[0];
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [result]);
  return (
    <section className="bg-card shadow-surface-2 flex flex-col gap-4 rounded-lg p-4 text-sm">
      <div role="status">
        <p ref={heading} tabIndex={-1} className="mb-2 font-semibold">
          {t("events.series.saved", { count: result.eventIds.length })}
        </p>
        <SeriesConflicts
          dates={result.conflicts.map(({ date }) => date)}
          conflicts={result.conflicts}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        {first ? (
          <Link className="underline underline-offset-4" to={`/events/${first}`}>
            {t("events.series.openFirst")}
          </Link>
        ) : null}
        <Link className="underline underline-offset-4" to="/calendar">
          {t("nav.calendar")}
        </Link>
      </div>
    </section>
  );
}

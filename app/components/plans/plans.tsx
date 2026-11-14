import { useEffect, useRef, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Textarea } from "@ui-sdk/react/textarea";
import { DateInput } from "@ui-sdk/react/date-input";
import { NumberInput, NumberInputControl, NumberInputGroup } from "@ui-sdk/react/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { ChevronDown } from "lucide-react";
import { buttonVariants } from "~/components/ui/button";
import { fieldClassName } from "~/components/ui/input";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDate } from "~/i18n/format";
import type { MessageKey } from "~/i18n";
import type { plansPageData } from "~/domains/plans/plans.routes.server";
import { inspectionStandard } from "~/domains/plans/plans.defaults";

type PageData = Awaited<ReturnType<typeof plansPageData>>;
type Plan = PageData["plans"][number];
const CONTROL = `${fieldClassName} min-h-12 px-control text-base sm:min-h-control sm:text-sm`;
const LINK = "min-w-0 break-words text-sm underline underline-offset-4";
const BUTTON = buttonVariants({ className: "min-h-12 sm:min-h-control" });
const SECONDARY = buttonVariants({ variant: "secondary", className: "min-h-12 sm:min-h-control" });

function Pick({
  name,
  label,
  items,
  value,
  onChange,
}: {
  name: string;
  label: string;
  items: { value: string; label: string }[];
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <Field name={name} className="min-w-0 space-y-1">
      <FieldLabel className="text-sm">{label}</FieldLabel>
      <Select
        name={name}
        items={items}
        defaultValue={value}
        onValueChange={(next) => onChange?.(next ?? "")}
      >
        <SelectTrigger className={`${CONTROL} flex w-full items-center justify-between gap-2`}>
          <SelectValue className="min-w-0 flex-1 truncate text-start" />
          <ChevronDown aria-hidden className="size-icon shrink-0" />
        </SelectTrigger>
        <SelectContent className="z-50 max-h-72 min-w-(--anchor-width) max-w-(--available-width) overflow-y-auto rounded-lg bg-popover p-1 shadow-surface-3">
          {items.map((item) => (
            <SelectItem
              key={item.value}
              value={item.value}
              className="min-h-control cursor-pointer break-words rounded-md px-control py-2 text-sm data-highlighted:bg-hover data-selected:bg-selected"
            >
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function MultiPick({
  name,
  label,
  items,
  selected,
}: {
  name: string;
  label: string;
  items: { id: string; name: string }[];
  selected: string[];
}) {
  const options = items.map((item) => ({ value: item.id, label: item.name }));
  return (
    <Field name={name} className="min-w-0 space-y-1">
      <FieldLabel className="text-sm">{label}</FieldLabel>
      <Select multiple name={name} items={options} defaultValue={selected}>
        <SelectTrigger className={`${CONTROL} flex w-full items-center justify-between gap-2`}>
          <SelectValue className="truncate" />
          <ChevronDown aria-hidden className="size-icon shrink-0" />
        </SelectTrigger>
        <SelectContent className="z-50 max-h-72 min-w-(--anchor-width) max-w-(--available-width) overflow-y-auto rounded-lg bg-popover p-1 shadow-surface-3">
          {options.map((item) => (
            <SelectItem
              key={item.value}
              value={item.value}
              className="min-h-control cursor-pointer break-words rounded-md px-control py-2 text-sm data-highlighted:bg-hover data-selected:bg-selected"
            >
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function TextField({
  name,
  label,
  value,
  url = false,
}: {
  name: string;
  label: string;
  value?: string;
  url?: boolean;
}) {
  return (
    <Field name={name} className="min-w-0 space-y-1">
      <FieldLabel className="text-sm">{label}</FieldLabel>
      <Input
        name={name}
        type={url ? "url" : "text"}
        required
        maxLength={url ? 2000 : 200}
        defaultValue={value}
        className={`${CONTROL} w-full`}
      />
    </Field>
  );
}

function DayField({ name, label, value }: { name: string; label: string; value?: string }) {
  const locale = useLocale();
  return (
    <Field name={name} className="space-y-1">
      <FieldLabel className="text-sm">{label}</FieldLabel>
      <DateInput
        name={name}
        locale={locale === "de" ? "de-DE" : "en-GB"}
        required
        defaultValue={value}
        className={`${CONTROL} flex items-center gap-1 [&_input]:w-12 [&_input]:bg-transparent [&_input]:text-center [&_input]:outline-offset-2`}
      />
    </Field>
  );
}

function PlanForm({ plan, page, action }: { plan?: Plan; page: PageData; action: string }) {
  const t = useT();
  const [workType, setWorkType] = useState(plan?.workType ?? "inspection");
  const [target, setTarget] = useState(plan?.target ?? "devices");
  const [schedule, setSchedule] = useState(plan?.semester ? "semester" : "months");
  const pending = useNavigation().state !== "idle";
  const items = (keys: string[]) =>
    keys.map((value) => ({ value, label: t(`plans.${value}` as MessageKey) }));
  return (
    <Form
      method="post"
      action={action}
      aria-label={t(plan ? "plans.edit" : "plans.new")}
      className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2"
    >
      <input type="hidden" name="intent" value="save" />
      <TextField name="name" label={t("plans.name")} value={plan?.name} />
      {plan ? (
        <input type="hidden" name="workType" value={workType} />
      ) : (
        <Pick
          name="workType"
          label={t("plans.workType")}
          items={items(["round", "inspection"])}
          value={workType}
          onChange={(value) => {
            setWorkType(value);
            setTarget(value === "round" ? "rooms" : "devices");
          }}
        />
      )}
      <Pick
        key={workType}
        name="target"
        label={t("plans.target")}
        items={items(workType === "round" ? ["rooms"] : ["devices", "kind", "portable"])}
        value={target}
        onChange={setTarget}
      />
      {target === "kind" ? (
        <Pick
          name="kindId"
          label={t("plans.kind")}
          value={plan?.kindId ?? ""}
          items={page.choices.kinds.map((item) => ({ value: item.id, label: item.name }))}
        />
      ) : null}
      {target === "devices" ? (
        <MultiPick
          name="equipmentIds"
          label={t("plans.devices")}
          items={page.choices.equipment}
          selected={plan?.equipment.map((item) => item.id) ?? []}
        />
      ) : null}
      {target === "rooms" ? (
        <div className="space-y-1">
          <MultiPick
            name="roomIds"
            label={t("plans.rooms")}
            items={page.choices.rooms}
            selected={plan?.rooms.map((item) => item.id) ?? []}
          />
          <p className="text-xs text-muted-foreground">{t("plans.allRooms")}</p>
        </div>
      ) : null}
      <Pick
        name="schedule"
        label={t("plans.schedule")}
        value={schedule}
        items={items(["months", "semester"])}
        onChange={setSchedule}
      />
      {schedule === "months" ? (
        <Field name="intervalMonths" className="space-y-1">
          <FieldLabel className="text-sm">{t("plans.monthCount")}</FieldLabel>
          <NumberInput
            name="intervalMonths"
            required
            min={1}
            max={120}
            defaultValue={plan?.intervalMonths ?? null}
          >
            <NumberInputGroup>
              <NumberInputControl className={`${CONTROL} w-full`} />
            </NumberInputGroup>
          </NumberInput>
        </Field>
      ) : null}
      <DayField name="startsAt" label={t("plans.firstDue")} value={plan?.date ?? page.today} />
      <Pick
        name="assigneeId"
        label={t("plans.assignee")}
        value={plan?.assigneeId ?? ""}
        items={[
          { value: "", label: t("plans.team") },
          ...page.choices.users.map((item) => ({ value: item.id, label: item.name })),
        ]}
      />
      <Field name="basis" className="space-y-1 sm:col-span-2">
        <FieldLabel className="text-sm">{t("plans.basis")}</FieldLabel>
        <Textarea
          name="basis"
          required
          maxLength={4000}
          defaultValue={plan?.basis}
          className={`${CONTROL} min-h-24 w-full py-2`}
        />
      </Field>
      <div className="sm:col-span-2">
        <TextField name="sourceUrl" label={t("plans.source")} value={plan?.sourceUrl} url />
      </div>
      <div>
        <Button type="submit" disabled={pending} className={BUTTON}>
          {t("plans.save")}
        </Button>
      </div>
    </Form>
  );
}

export function PlanDueRows({
  rows,
  mobile = false,
  paginate = false,
}: {
  rows: (PageData["occurrences"][number] & { count?: number })[];
  mobile?: boolean;
  paginate?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [page, setPage] = useState(0);
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 50) - 1));
  const shown = paginate ? rows.slice(current * 50, (current + 1) * 50) : rows;
  return (
    <>
      <ul className="divide-y">
        {shown.map((row) => (
          <li
            key={row.id}
            className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3"
          >
            <div className="min-w-0 flex-1">
              <Link className={`${LINK} block`} to={`${mobile ? "/m" : ""}${row.href}`}>
                {(row.count ?? 0) > 1
                  ? t("plans.deviceCount", { plan: row.title, count: row.count! })
                  : row.device
                    ? `${row.title} · ${row.device.name}`
                    : row.title}
              </Link>
              <p className="text-xs text-muted-foreground">
                {[row.anchor, row.assignee ?? t("plans.team")].filter(Boolean).join(" · ")}
              </p>
            </div>
            <span className="nums text-sm">
              {row.due ? `${t("plans.due")} · ` : ""}
              {formatDate(locale, row.date)}
            </span>
          </li>
        ))}
      </ul>
      {paginate && rows.length > 50 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            className={SECONDARY}
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            {t("plans.previous")}
          </Button>
          <p className="nums text-xs text-muted-foreground">
            {t("plans.pageRange", {
              from: current * 50 + 1,
              to: Math.min((current + 1) * 50, rows.length),
              total: rows.length,
            })}
          </p>
          <Button
            type="button"
            className={SECONDARY}
            disabled={(current + 1) * 50 >= rows.length}
            onClick={() => setPage(current + 1)}
          >
            {t("plans.nextPage")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SemesterForm({
  action,
  row,
}: {
  action: string;
  row?: PageData["choices"]["semesters"][number];
}) {
  const t = useT();
  const pending = useNavigation().state !== "idle";
  return (
    <Form
      method="post"
      action={action}
      aria-label={row ? `${t("plans.editSemester")} · ${row.name}` : t("plans.addSemester")}
      className="mt-3 grid gap-4 sm:grid-cols-2"
    >
      <input type="hidden" name="intent" value="semester" />
      {row ? <input type="hidden" name="semesterId" value={row.id} /> : null}
      <TextField name="name" label={t("plans.semesterName")} value={row?.name} />
      <DayField
        name="startsAt"
        label={t("plans.semesterDate")}
        value={
          row
            ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(row.startsAt)
            : undefined
        }
      />
      <div>
        <Button type="submit" disabled={pending} className={SECONDARY}>
          {t("plans.addSemester")}
        </Button>
      </div>
    </Form>
  );
}

export function PlansPage({
  page,
  error,
  saved,
  mobile = false,
}: {
  page: PageData;
  error?: string;
  saved?: boolean;
  mobile?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const path = `${mobile ? "/m" : ""}/plans`;
  const plan = page.detail ? page.plans[0] : undefined;
  const action = plan ? `${path}/${plan.id}` : path;
  const selected = page.occurrences.find(
    (row) =>
      row.device?.id === page.deviceId &&
      (!page.plannedFor || new Date(row.date).getTime() === new Date(page.plannedFor).getTime()),
  );
  const pending = useNavigation().state !== "idle";
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  return (
    <div className={`min-w-0 space-y-5 ${mobile ? "p-4" : ""}`}>
      {plan ? (
        <Link to={path} className={LINK}>
          {t("plans.title")}
        </Link>
      ) : null}
      <h1 className="break-words text-xl font-bold">{plan?.name ?? t("plans.title")}</h1>
      {error ? (
        <p role="alert" tabIndex={-1} ref={errorRef} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm">
          {t("plans.saved")}
        </p>
      ) : null}
      {plan ? (
        <>
          <section
            className="space-y-3 rounded-lg bg-card p-4 shadow-surface-2"
            aria-label={t("plans.basis")}
          >
            <p className="text-sm">
              {t(plan.enabled ? "plans.on" : "plans.off")} ·{" "}
              {plan.assignee?.name ?? t("plans.team")}
            </p>
            {selected ? (
              <Collapsible>
                <CollapsibleTrigger
                  type="button"
                  className={`${LINK} inline-flex min-h-12 items-center gap-2 sm:min-h-control`}
                >
                  {t("plans.basis")}
                  <ChevronDown aria-hidden className="size-icon" />
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <p className="max-w-prose text-sm">{plan.basis}</p>
                </CollapsiblePanel>
              </Collapsible>
            ) : (
              <p className="max-w-prose text-sm">{plan.basis}</p>
            )}
            <a href={plan.sourceUrl} className={LINK} target="_blank" rel="noreferrer">
              {t("plans.source")}
            </a>
            {plan.systemKey === "portable-electrical" ? (
              <a
                href={inspectionStandard}
                className={`${LINK} ms-4`}
                target="_blank"
                rel="noreferrer"
              >
                {t("plans.standard")}
              </a>
            ) : null}
            {page.admin && !selected ? (
              <Form method="post" action={action}>
                <input type="hidden" name="intent" value="toggle" />
                <input type="hidden" name="enabled" value={String(!plan.enabled)} />
                <Button type="submit" disabled={pending} className={SECONDARY}>
                  {t(plan.enabled ? "plans.disable" : "plans.enable")}
                </Button>
              </Form>
            ) : null}
          </section>
          {selected?.device ? (
            <section className="space-y-3 rounded-lg bg-card p-4 shadow-surface-2">
              <h2 className="break-words text-lg font-semibold">{selected.device.name}</h2>
              <p className="nums text-sm" data-next-due>
                {t("plans.next", { date: formatDate(locale, selected.date) })}
              </p>
              {selected.latest ? (
                <p className="text-sm">
                  {t("plans.last", {
                    date: formatDate(locale, selected.latest.observedAt),
                    result: t(selected.latest.passed ? "plans.passed" : "plans.failed"),
                  })}
                </p>
              ) : null}
              <p className="max-w-prose text-sm text-muted-foreground">
                {t("plans.inspectionHelp")}
              </p>
              <Form
                method="post"
                action={`${mobile ? "/m" : ""}${selected.href}`}
                aria-label={t("plans.record")}
                className="grid gap-4 sm:grid-cols-2"
              >
                <input type="hidden" name="intent" value="inspect" />
                <input type="hidden" name="equipmentId" value={selected.device.id} />
                {plan.semester ? (
                  <input
                    type="hidden"
                    name="plannedFor"
                    value={new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(
                      selected.date,
                    )}
                  />
                ) : null}
                <Pick
                  name="passed"
                  label={t("plans.result")}
                  value="true"
                  items={[
                    { value: "true", label: t("plans.passed") },
                    { value: "false", label: t("plans.failed") },
                  ]}
                />
                <DayField name="observedAt" label={t("plans.observedAt")} value={page.today} />
                <TextField name="source" label={t("plans.evidence")} />
                {page.functions.length ? (
                  <Pick
                    name="functionId"
                    label={t("plans.function")}
                    value={page.functions.length === 1 ? page.functions[0].id : ""}
                    items={[
                      { value: "", label: t("plans.chooseFunction") },
                      ...page.functions.map((item) => ({ value: item.id, label: item.name })),
                    ]}
                  />
                ) : null}
                <div>
                  <Button type="submit" disabled={pending} className={BUTTON}>
                    {t("plans.saveInspection")}
                  </Button>
                </div>
              </Form>
              <Link
                to={`${mobile ? "/m" : ""}/inventory/${selected.device.id}/readings?history=1`}
                className={LINK}
              >
                {t("readings.history")}
              </Link>
            </section>
          ) : null}
          {!selected ? (
            <section className="rounded-lg bg-card p-4 shadow-surface-2">
              <h2 className="text-lg font-semibold">{t("plans.occurrences")}</h2>
              {!page.occurrences.length ? (
                <p className="mt-2 text-sm text-muted-foreground">{t("plans.noOccurrences")}</p>
              ) : null}
              <PlanDueRows rows={page.occurrences} mobile={mobile} paginate />
              {plan.workType === "round"
                ? page.occurrences.map((row) =>
                    row.roundId ? (
                      <Link
                        key={row.id}
                        to={`${mobile ? "/m" : ""}/rounds/${row.roundId}`}
                        className={`${LINK} me-4 inline-block py-2`}
                      >
                        {t("plans.openRound")} · {formatDate(locale, row.date)}
                      </Link>
                    ) : (
                      <Form key={row.id} method="post" action={action} className="mt-3">
                        <input type="hidden" name="intent" value="start" />
                        <input
                          type="hidden"
                          name="plannedFor"
                          value={new Intl.DateTimeFormat("sv-SE", {
                            timeZone: "Europe/Berlin",
                          }).format(row.date)}
                        />
                        <Button type="submit" disabled={pending} className={SECONDARY}>
                          {t("plans.startRound")} · {formatDate(locale, row.date)}
                        </Button>
                      </Form>
                    ),
                  )
                : null}
            </section>
          ) : null}
          {page.admin && !selected ? (
            <Collapsible>
              <CollapsibleTrigger type="button" className={SECONDARY}>
                {t("plans.edit")}
                <ChevronDown aria-hidden className="size-icon" />
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <PlanForm
                  key={plan.updatedAt.toISOString()}
                  plan={plan}
                  page={page}
                  action={action}
                />
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </>
      ) : (
        <>
          <p className="max-w-prose text-sm text-muted-foreground">{t("plans.intro")}</p>
          <section className="rounded-lg bg-card p-4 shadow-surface-2">
            <h2 className="text-lg font-semibold">{t("plans.occurrences")}</h2>
            {!page.plans.length ? (
              <p className="mt-2 text-sm text-muted-foreground">{t("plans.empty")}</p>
            ) : null}
            <ul className="divide-y">
              {page.plans.map((row) => (
                <li key={row.id} className="flex min-w-0 items-center justify-between gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link to={`${path}/${row.id}`} className={LINK}>
                      {row.name}
                    </Link>
                    {page.occurrences.find((item) => item.planId === row.id) ? (
                      <p className="nums mt-1 text-xs text-muted-foreground">
                        {t("plans.next", {
                          date: formatDate(
                            locale,
                            page.occurrences.find((item) => item.planId === row.id)!.date,
                          ),
                        })}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t(row.enabled ? "plans.on" : "plans.off")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {page.admin ? (
            <>
              <section className="space-y-3 rounded-lg bg-card p-4 shadow-surface-2">
                <h2 className="text-lg font-semibold">{t("plans.defaults")}</h2>
                {page.defaults
                  .filter((item) => !page.plans.some((plan) => plan.systemKey === item.key))
                  .map((item) => (
                    <div key={item.key} className="space-y-2 py-2">
                      <h3 className="text-sm font-semibold">{t(item.name)}</h3>
                      <p className="max-w-prose text-sm text-muted-foreground">{t(item.basis)}</p>
                      <a href={item.sourceUrl} className={LINK} target="_blank" rel="noreferrer">
                        {t("plans.source")}
                      </a>
                      <Form method="post" action={path} aria-label={t(item.name)}>
                        <input type="hidden" name="intent" value="default" />
                        <input type="hidden" name="key" value={item.key} />
                        <Button type="submit" disabled={pending} className={SECONDARY}>
                          {t("plans.enable")}
                        </Button>
                      </Form>
                    </div>
                  ))}
                <h3 className="text-sm font-semibold">{t("plans.filters")}</h3>
                <p className="max-w-prose text-sm text-muted-foreground">
                  {t("plans.filtersBasis")}
                </p>
                <Link to={mobile ? "/m/due" : "/due"} className={LINK}>
                  {t("plans.due")}
                </Link>
              </section>
              <Collapsible>
                <CollapsibleTrigger type="button" className={SECONDARY}>
                  {t("plans.new")}
                  <ChevronDown aria-hidden className="size-icon" />
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <PlanForm page={page} action={path} />
                </CollapsiblePanel>
              </Collapsible>
            </>
          ) : null}
        </>
      )}
      {page.admin && !selected ? (
        <section className="space-y-3 rounded-lg bg-card p-4 shadow-surface-2">
          <h2 className="text-lg font-semibold">{t("plans.semesters")}</h2>
          <p className="max-w-prose text-sm text-muted-foreground">{t("plans.semestersHelp")}</p>
          <ul className="divide-y">
            {page.choices.semesters.map((row) => (
              <li key={row.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 break-words">{row.name}</span>
                  <span className="nums shrink-0">{formatDate(locale, row.startsAt)}</span>
                  <Form method="post" action={action}>
                    <input type="hidden" name="intent" value="removeSemester" />
                    <input type="hidden" name="semesterId" value={row.id} />
                    <Button
                      type="submit"
                      aria-label={`${t("plans.removeSemester")} · ${row.name}`}
                      disabled={pending}
                      className={SECONDARY}
                    >
                      {t("plans.removeSemester")}
                    </Button>
                  </Form>
                </div>
                <Collapsible>
                  <CollapsibleTrigger
                    type="button"
                    className={`${LINK} inline-flex min-h-12 items-center sm:min-h-control`}
                    aria-label={`${t("plans.editSemester")} · ${row.name}`}
                  >
                    {t("plans.editSemester")}
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <SemesterForm action={action} row={row} />
                  </CollapsiblePanel>
                </Collapsible>
              </li>
            ))}
          </ul>
          <SemesterForm action={action} />
        </section>
      ) : null}
    </div>
  );
}

import { useEffect, useRef } from "react";
import { data, Form, useNavigation, useRevalidator } from "react-router";
import { Button } from "@ui-sdk/react/button";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/react/radio";
import { Check, Circle } from "lucide-react";
import type { Route } from "./+types/route";
import { buttonVariants } from "~/components/ui/button";
import { fieldClassName } from "~/components/ui/input";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { mailActionSchema } from "~/domains/mail/mail.schema";
import {
  listMailDeliveries,
  mailWorkerReady,
  queueTestMail,
  readMailSettings,
  saveSmtp,
} from "~/domains/mail/mail.server";
import { requireRole } from "~/lib/auth.server";
import { logger } from "~/lib/observability/logger.server";
import { safeParseForm } from "~/lib/validation.server";
import { t, type MessageKey } from "~/i18n";
import { formatDateTime } from "~/i18n/format";
import { metaLocale } from "~/i18n/meta";
import { resolveLocale } from "~/i18n/locale.server";
import { useLocale, useT } from "~/i18n/use-t";

const cache = { headers: { "Cache-Control": "no-store" } };
const endpoint = "/admin/mail";
const checkClass =
  "grid size-5 shrink-0 place-items-center rounded border border-input focus-visible:outline-2 focus-visible:outline-ring data-checked:bg-selected";

export function headers() {
  return cache.headers;
}

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireRole(request, "ADMIN");
  const [settings, deliveries] = await Promise.all([readMailSettings(), listMailDeliveries()]);
  return data({ ...settings, deliveries, email: actor.email, worker: mailWorkerReady() }, cache);
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new Response(null, { status: 403 });
  }
  const parsed = await safeParseForm(request, mailActionSchema);
  if (!parsed.success) {
    return data({ error: "admin.mail.invalid" as const }, { ...cache, status: 422 });
  }
  try {
    if (parsed.data.intent === "save") {
      const { intent: _intent, ...config } = parsed.data;
      if (config.clearPassword && config.password) {
        return data({ error: "admin.mail.passwordConflict" as const }, { ...cache, status: 422 });
      }
      return (await saveSmtp(actor, config))
        ? data({ result: "admin.mail.saved" as const }, cache)
        : data({ error: "admin.mail.needsUsername" as const }, { ...cache, status: 422 });
    }
    const locale = resolveLocale(request);
    const row = await queueTestMail(actor, {
      recipient: actor.email,
      subject: t(locale, "admin.mail.template.subject"),
      text: t(locale, "admin.mail.template.text"),
    });
    return data(
      {
        result:
          row.status === "queued"
            ? ("admin.mail.queued" as const)
            : ("admin.mail.skipped" as const),
      },
      cache,
    );
  } catch {
    logger.error({ intent: parsed.data.intent }, "[mail] Could not complete admin request");
    return data({ error: "admin.mail.operationFailed" as const }, { ...cache, status: 503 });
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.mail.meta") }];
}

export default function MailAdmin({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const navigation = useNavigation();
  const { revalidate, state } = useRevalidator();
  const { config, deliveries, email, passwordSet, ready, worker, unreadable } = loaderData;
  const pending = deliveries.some((row) => row.status === "queued");
  const busy = navigation.state !== "idle";
  const saveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (actionData && "result" in actionData && actionData.result === "admin.mail.saved") {
      saveButton.current?.focus();
    }
  }, [actionData, config?.revision]);
  useEffect(() => {
    if (!pending || busy || state !== "idle") return;
    const timer = window.setTimeout(() => void revalidate(), 2500);
    return () => window.clearTimeout(timer);
  }, [pending, busy, state, revalidate]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header>
        <h1 className="type-display">{t("admin.mail.title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("admin.mail.intro")}</p>
      </header>

      <section className="bg-card shadow-surface-2 grid gap-5 rounded-lg p-4 lg:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
        <Form
          key={config?.revision ?? "empty"}
          action={endpoint}
          method="post"
          aria-labelledby="smtp-settings"
          className="space-y-3"
        >
          <h2 id="smtp-settings" className="type-subtitle">
            {t("admin.mail.settings")}
          </h2>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <MailField name="host" value={config?.host} required maxLength={253} />
            <MailField
              name="port"
              value={String(config?.port ?? 587)}
              type="number"
              min={1}
              max={65535}
              required
            />
          </div>
          <fieldset>
            <legend className="mb-1 text-sm">{t("admin.mail.tls")}</legend>
            <RadioGroup
              name="tls"
              defaultValue={config?.tls ?? "starttls"}
              className="flex flex-wrap gap-x-4 gap-y-1"
            >
              {(["starttls", "tls"] as const).map((value) => (
                <label key={value} className="flex min-h-control items-center gap-2 text-sm">
                  <Radio value={value} className={`${checkClass} rounded-full`}>
                    <RadioIndicator>
                      <Circle aria-hidden className="size-2 fill-current" />
                    </RadioIndicator>
                  </Radio>
                  {t(`admin.mail.tls.${value}`)}
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <MailField name="from" type="email" value={config?.from} required maxLength={254} />
          <div className="grid gap-3 sm:grid-cols-2">
            <MailField name="username" value={config?.username} maxLength={512} />
            <MailField name="password" type="password" maxLength={1024} passwordSet={passwordSet} />
          </div>
          {passwordSet || unreadable ? <MailCheck name="clearPassword" /> : null}
          <MailCheck name="enabled" checked={config?.enabled} />
          <Button
            ref={saveButton}
            className={buttonVariants()}
            type="submit"
            name="intent"
            value="save"
            disabled={busy}
          >
            {t("admin.mail.save")}
          </Button>
        </Form>
        <Form
          action={endpoint}
          method="post"
          aria-labelledby="smtp-test"
          className="space-y-3 border-t pt-4 lg:border-s lg:border-t-0 lg:ps-5 lg:pt-0"
        >
          <h2 id="smtp-test" className="type-subtitle">
            {t("admin.mail.test")}
          </h2>
          <p className="break-words text-sm">{t("admin.mail.testTo", { email })}</p>
          <p className="text-muted-foreground text-sm" role="status">
            {t(
              ready
                ? "admin.mail.ready"
                : unreadable
                  ? "admin.mail.reason.configuration"
                  : !worker
                    ? "admin.mail.workerOff"
                    : config?.enabled
                      ? "admin.mail.needsTest"
                      : "admin.mail.off",
            )}
          </p>
          <Button
            className={buttonVariants({ variant: "secondary" })}
            type="submit"
            name="intent"
            value="test"
            disabled={busy || !config?.enabled || !worker}
          >
            {t("admin.mail.sendTest")}
          </Button>
        </Form>
        {actionData && "error" in actionData ? (
          <p role="alert" className="text-destructive text-sm lg:col-span-2">
            {t(actionData.error)}
          </p>
        ) : null}
        {actionData && "result" in actionData ? (
          <p role="status" className="text-sm lg:col-span-2">
            {t(actionData.result)}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="mail-log" className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="mail-log" className="type-subtitle">
              {t("admin.mail.log")}
            </h2>
            <p className="text-muted-foreground text-sm">{t("admin.mail.logDescription")}</p>
          </div>
          <Button
            type="button"
            className={buttonVariants({ variant: "secondary" })}
            onClick={() => void revalidate()}
            disabled={state !== "idle"}
          >
            {t("admin.mail.refresh")}
          </Button>
        </div>
        {deliveries.length ? (
          <div className="bg-card shadow-surface-2 overflow-hidden rounded-lg">
            <table className="w-full table-fixed text-start text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr className="border-b [&>th]:px-3 [&>th]:py-2 [&>th]:text-start">
                  <th scope="col" className="w-[30%]">
                    {t("admin.mail.recipient")}
                  </th>
                  <th scope="col" className="w-[23%]">
                    {t("admin.mail.result")}
                  </th>
                  <th scope="col">{t("admin.mail.reply")}</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b align-top last:border-0 [&>*]:px-3 [&>*]:py-row"
                  >
                    <th scope="row" className="text-start font-normal">
                      <p className="truncate" title={row.recipient}>
                        {row.recipient}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {formatDateTime(locale, row.createdAt)}
                      </p>
                    </th>
                    <td className="break-words">
                      {t(`admin.mail.status.${row.status}` as MessageKey)}
                      {row.attempts ? (
                        <p className="text-muted-foreground text-xs">
                          {t("admin.mail.attempts", { count: row.attempts })}
                        </p>
                      ) : null}
                    </td>
                    <td className="wrap-anywhere">
                      {row.reason ? (
                        <p>{t(`admin.mail.reason.${row.reason}` as MessageKey)}</p>
                      ) : null}
                      {row.reply ?? (!row.reason ? "—" : null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="bg-card shadow-surface-2 text-muted-foreground rounded-lg p-4 text-sm">
            {t("admin.mail.empty")}
          </p>
        )}
      </section>
    </div>
  );
}

function MailField({
  name,
  value,
  passwordSet,
  ...props
}: React.ComponentProps<typeof Input> & {
  name: "host" | "port" | "from" | "username" | "password";
  passwordSet?: boolean;
}) {
  const t = useT();
  return (
    <Field name={name} className="min-w-0 space-y-1">
      <FieldLabel className="text-sm">{t(`admin.mail.${name}`)}</FieldLabel>
      <Input
        {...props}
        name={name}
        className={`${fieldClassName} h-control px-control`}
        defaultValue={value}
        autoComplete={name === "password" ? "new-password" : "off"}
        autoCapitalize="none"
        spellCheck={false}
        aria-describedby={passwordSet ? "smtp-password-hint" : undefined}
      />
      {passwordSet ? (
        <p id="smtp-password-hint" className="text-muted-foreground text-xs">
          {t("admin.mail.passwordSet")}
        </p>
      ) : null}
    </Field>
  );
}

function MailCheck({ name, checked }: { name: "clearPassword" | "enabled"; checked?: boolean }) {
  const t = useT();
  return (
    <label className="flex min-h-control items-center gap-2 text-sm">
      <Checkbox name={name} value="on" defaultChecked={checked} className={checkClass}>
        <CheckboxIndicator>
          <Check aria-hidden className="size-4" />
        </CheckboxIndicator>
      </Checkbox>
      {t(`admin.mail.${name}`)}
    </label>
  );
}

export { RouteErrorBoundary as ErrorBoundary };

import * as React from "react";
import { data, Form, useNavigation } from "react-router";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import type { Route } from "./+types/route";
import { adminTwoFactorRequired, requireUser } from "~/lib/auth.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { safeParseForm, z } from "~/lib/validation.server";
import {
  changeOwnPassword,
  changePasswordSchema,
  getNotificationEmailOptOuts,
  saveNotificationEmailOptOuts,
} from "~/domains/auth/account.server";
import { accountMailReady, requestEmailVerification } from "~/domains/auth/account-mail.server";
import { NotificationType } from "~/generated/prisma/enums";
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
  canManageAllPersonalAccessTokens,
} from "~/domains/api-tokens/api-tokens.server";
import { tokenCreateSchema } from "~/domains/api-tokens/api-tokens.schema";
import {
  confirmTwoFactorEnrolment,
  disableOwnTwoFactor,
  regenerateBackupCodes,
  startTwoFactorEnrolment,
  twoFactorCodeSchema,
  twoFactorPasswordSchema,
  type TwoFactorEnrolment,
} from "~/domains/auth/two-factor.server";
import { ZodForm, FormField, type FieldErrors } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Button, buttonVariants } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { roleLabel } from "~/components/auth/labels";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";
import { PersonalAccessTokens } from "~/routes/_desktop.account/personal-access-tokens";

type Intent =
  | "password"
  | "twoFactorStart"
  | "twoFactorConfirm"
  | "twoFactorDisable"
  | "twoFactorRegenerate"
  | "verifyEmail"
  | "notificationEmail"
  | "tokenCreate"
  | "tokenRevoke";

interface AccountActionData {
  intent: Intent;
  changed?: boolean;
  fieldErrors?: FieldErrors;
  formErrors?: string[];
  enrolment?: TwoFactorEnrolment;
  backupCodes?: string[];
  createdToken?: { token: string; id: string };
}

const tokenRevokeSchema = z.object({ id: z.string().min(1) });
const notificationTypes = Object.values(NotificationType);
const notificationEmailSchema = z.object({
  emailType: z.preprocess(
    (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
    z.array(z.enum(NotificationType)).max(notificationTypes.length),
  ),
});

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  try {
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        initials: user.initials,
        role: user.role,
      },
      twoFactorEnabled: user.twoFactorEnabled,
      canVerifyEmail: !user.emailVerified && (await accountMailReady()),
      notificationEmailOptOuts: await getNotificationEmailOptOuts(user.id),
      mcpUrl: `${new URL(request.url).origin}/mcp`,
      twoFactorRequired:
        user.role === "ADMIN" && adminTwoFactorRequired() && !user.twoFactorEnabled,
      tokens: await listPersonalAccessTokens(user, { all: canManageAllPersonalAccessTokens(user) }),
    };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

/**
 * Each cookie stays its own Set-Cookie header (session token and, when set, the
 * remember-me and cookie-cache cookies).
 */
function forwardCookies(from: Headers): Headers {
  const headers = new Headers();
  for (const cookie of from.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const requested = (await request.clone().formData()).get("intent");
  const intent: Intent =
    requested === "twoFactorStart" ||
    requested === "twoFactorConfirm" ||
    requested === "twoFactorDisable" ||
    requested === "twoFactorRegenerate" ||
    requested === "verifyEmail" ||
    requested === "notificationEmail" ||
    requested === "tokenCreate" ||
    requested === "tokenRevoke"
      ? requested
      : "password";
  const reply = (rest: Omit<AccountActionData, "intent"> = {}): AccountActionData => ({
    intent,
    ...rest,
  });
  try {
    if (
      (intent === "tokenCreate" ||
        intent === "tokenRevoke" ||
        intent === "verifyEmail" ||
        intent === "notificationEmail") &&
      request.headers.get("origin") !== new URL(request.url).origin
    ) {
      throw new Response(null, { status: 403 });
    }
    if (intent === "verifyEmail") {
      const changed = !user.emailVerified && (await requestEmailVerification(user.email, request));
      return reply({ changed });
    }
    if (intent === "notificationEmail") {
      const result = await safeParseForm(request, notificationEmailSchema);
      if (!result.success) return data(reply({ changed: false }), { status: 422 });
      const enabled = new Set(result.data.emailType);
      await saveNotificationEmailOptOuts(
        user,
        notificationTypes.filter((type) => !enabled.has(type)),
      );
      return reply({ changed: true });
    }
    if (intent === "tokenCreate") {
      const result = await safeParseForm(request, tokenCreateSchema);
      if (!result.success)
        return reply({ fieldErrors: result.fieldErrors, formErrors: result.formErrors });
      const { token, record } = await createPersonalAccessToken(user, result.data);
      return data(reply({ createdToken: { token, id: record.id } }), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (intent === "tokenRevoke") {
      const result = await safeParseForm(request, tokenRevokeSchema);
      if (!result.success)
        return reply({ fieldErrors: result.fieldErrors, formErrors: result.formErrors });
      await revokePersonalAccessToken(user, result.data.id);
      return reply({ changed: true });
    }
    if (intent === "password") {
      const result = await safeParseForm(request, changePasswordSchema);
      if (!result.success) return reply({ fieldErrors: result.fieldErrors });
      // Better Auth revoked the old session with the others; this browser stays
      // signed in on the new one.
      const headers = await changeOwnPassword(user, request, result.data);
      return data(reply({ changed: true }), { headers: forwardCookies(headers) });
    }
    if (intent === "twoFactorConfirm") {
      const result = await safeParseForm(request, twoFactorCodeSchema);
      if (!result.success) return reply({ fieldErrors: result.fieldErrors });
      const headers = await confirmTwoFactorEnrolment(user, request, result.data.code);
      return data(reply(), { headers: forwardCookies(headers) });
    }
    const result = await safeParseForm(request, twoFactorPasswordSchema);
    if (!result.success) return reply({ fieldErrors: result.fieldErrors });
    const { password } = result.data;
    if (intent === "twoFactorStart") {
      return reply({ enrolment: await startTwoFactorEnrolment(request, password) });
    }
    if (intent === "twoFactorDisable") {
      const headers = await disableOwnTwoFactor(user, request, password);
      return data(reply(), { headers: forwardCookies(headers) });
    }
    return reply({ backupCodes: await regenerateBackupCodes(user, request, password) });
  } catch (e) {
    if (e instanceof ValidationError) {
      return reply({ fieldErrors: e.fieldErrors, formErrors: e.formErrors });
    }
    throw toErrorResponse(e);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "account.meta") }];
}

function BackupCodes({ codes }: { codes: string[] }) {
  const t = useT();
  return (
    <div className="mt-4">
      <p className="text-sm font-semibold">{t("account.twoFactor.backupCodes")}</p>
      <p className="text-muted-foreground mt-1 text-xs">{t("account.twoFactor.backupHint")}</p>
      <ul
        aria-label={t("account.twoFactor.backupCodes")}
        className="bg-card shadow-surface-2 mt-2 grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg p-3 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
    </div>
  );
}

function FormErrors({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p role="alert" className="text-destructive mt-4 text-sm">
      {errors.join(" ")}
    </p>
  );
}

function NotificationEmailPreferences({
  optOuts,
  changed,
}: {
  optOuts: NotificationType[];
  changed?: boolean;
}) {
  const t = useT();
  const navigation = useNavigation();
  const saving = navigation.formData?.get("intent") === "notificationEmail";
  return (
    <section className="mt-8" aria-labelledby="notification-email-heading">
      <h2 id="notification-email-heading" className="scroll-mt-18 text-base font-semibold">
        {t("account.notificationEmail.heading")}
      </h2>
      <p className="text-muted-foreground mt-1 text-sm">{t("account.notificationEmail.intro")}</p>
      <Form
        method="post"
        action="/account"
        preventScrollReset
        aria-labelledby="notification-email-heading"
        className="mt-3"
      >
        <input type="hidden" name="intent" value="notificationEmail" />
        <fieldset className="bg-card shadow-surface-2 divide-y rounded-lg">
          <legend className="sr-only">{t("account.notificationEmail.heading")}</legend>
          {notificationTypes.map((type) => (
            <label
              key={type}
              className="hover:bg-hover py-row flex cursor-pointer items-center justify-between gap-4 px-3 text-sm first-of-type:rounded-t-lg last:rounded-b-lg pointer-coarse:min-h-12"
            >
              {t(`account.notificationEmail.${type}`)}
              <Switch
                name="emailType"
                value={type}
                defaultChecked={!optOuts.includes(type)}
                className="bg-switch-track data-checked:bg-fluid-accent relative h-5 w-[34px] shrink-0 rounded-full transition-colors duration-160 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) motion-reduce:transition-none"
              >
                <SwitchThumb className="bg-switch-thumb absolute start-0.5 top-0.5 size-4 rounded-full shadow-(--switch-shadow) transition-transform duration-160 ease-(--ease-press) data-checked:translate-x-3.5 motion-reduce:transition-none rtl:data-checked:-translate-x-3.5" />
              </Switch>
            </label>
          ))}
        </fieldset>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <SdkButton
            type="submit"
            className={buttonVariants({ variant: "secondary" })}
            disabled={saving}
          >
            {t(saving ? "account.notificationEmail.saving" : "account.notificationEmail.save")}
          </SdkButton>
          <p role="status" className="text-sm">
            {changed && !saving ? t("account.notificationEmail.saved") : null}
          </p>
          {changed === false && !saving ? (
            <p role="alert" className="text-destructive text-sm">
              {t("account.notificationEmail.error")}
            </p>
          ) : null}
        </div>
      </Form>
    </section>
  );
}

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const { user, twoFactorEnabled, twoFactorRequired, canVerifyEmail } = loaderData;
  const result = actionData as AccountActionData | undefined;
  const of = (intent: Intent) => (result?.intent === intent ? result : undefined);
  const changed = of("password")?.changed === true;
  const formRef = React.useRef<HTMLFormElement>(null);
  // Clear the password fields after each successful change.
  React.useEffect(() => {
    if (changed) formRef.current?.reset();
  }, [actionData, changed]);

  // The QR code, key and backup codes come back once, from the start step; keep
  // them on screen while the code is confirmed, including after a wrong code.
  const [enrolment, setEnrolment] = React.useState<TwoFactorEnrolment | null>(
    result?.enrolment ?? null,
  );
  const [seen, setSeen] = React.useState(result);
  if (seen !== result) {
    setSeen(result);
    if (result?.enrolment) setEnrolment(result.enrolment);
  }
  const confirmed =
    twoFactorEnabled && result?.intent === "twoFactorConfirm" && !result.fieldErrors;
  const disabled =
    !twoFactorEnabled && result?.intent === "twoFactorDisable" && !result.fieldErrors;
  const regenerated = of("twoFactorRegenerate")?.backupCodes;
  const twoFactorErrors = result?.intent.startsWith("twoFactor") ? result : undefined;

  return (
    <div className="max-w-lg">
      <h1 className="text-xl font-bold">{t("account.title")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t("account.subtitle")}</p>

      {twoFactorRequired ? (
        <p
          role="alert"
          className="bg-status-warning/15 text-foreground mt-4 rounded-lg p-3 text-sm"
        >
          {t("account.twoFactor.required")}
        </p>
      ) : null}

      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("account.name")}</dt>
        <dd>{user.name}</dd>
        <dt className="text-muted-foreground">{t("account.email")}</dt>
        <dd>{user.email}</dd>
        <dt className="text-muted-foreground">{t("account.initials")}</dt>
        <dd>{user.initials ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("account.role")}</dt>
        <dd>{roleLabel(locale, user.role)}</dd>
      </dl>
      {canVerifyEmail ? (
        <Form method="post" className="mt-3 space-y-2">
          <p className="text-muted-foreground text-sm">{t("auth.mail.accountUnverified")}</p>
          <SdkButton
            type="submit"
            name="intent"
            value="verifyEmail"
            className={buttonVariants({ variant: "secondary" })}
          >
            {t("auth.mail.verifyAction")}
          </SdkButton>
          {of("verifyEmail") ? (
            <p role="status" className="text-sm">
              {t(
                of("verifyEmail")?.changed
                  ? "auth.mail.verifyQueued"
                  : "auth.mail.verifyUnavailable",
              )}
            </p>
          ) : null}
        </Form>
      ) : null}

      <h2 className="mt-8 text-base font-semibold">{t("account.twoFactor.heading")}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{t("account.twoFactor.intro")}</p>
      <p className="mt-2 text-sm font-semibold" data-testid="two-factor-status">
        {twoFactorEnabled ? t("account.twoFactor.statusOn") : t("account.twoFactor.statusOff")}
      </p>
      {confirmed ? (
        <p role="status" className="bg-status-info/15 text-foreground mt-4 rounded-lg p-3 text-sm">
          {t("account.twoFactor.enabled")}
        </p>
      ) : null}
      {disabled ? (
        <p role="status" className="bg-status-info/15 text-foreground mt-4 rounded-lg p-3 text-sm">
          {t("account.twoFactor.disabled")}
        </p>
      ) : null}
      <FormErrors errors={twoFactorErrors?.formErrors} />

      {twoFactorEnabled ? (
        <>
          {confirmed && enrolment ? <BackupCodes codes={enrolment.backupCodes} /> : null}
          {regenerated ? (
            <>
              <p
                role="status"
                className="bg-status-info/15 text-foreground mt-4 rounded-lg p-3 text-sm"
              >
                {t("account.twoFactor.regenerated")}
              </p>
              <BackupCodes codes={regenerated} />
            </>
          ) : null}
          <p className="text-muted-foreground mt-4 text-sm">{t("account.twoFactor.manageIntro")}</p>
          <ZodForm
            className="mt-2"
            fieldErrors={
              of("twoFactorDisable")?.fieldErrors ?? of("twoFactorRegenerate")?.fieldErrors
            }
          >
            <FormField name="password" label={t("account.twoFactor.password")}>
              <Input name="password" type="password" required autoComplete="current-password" />
            </FormField>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" name="intent" value="twoFactorRegenerate" variant="secondary">
                {t("account.twoFactor.regenerate")}
              </Button>
              <Button type="submit" name="intent" value="twoFactorDisable" variant="destructive">
                {t("account.twoFactor.disable")}
              </Button>
            </div>
          </ZodForm>
        </>
      ) : enrolment ? (
        <div className="mt-4">
          <p className="text-sm">{t("account.twoFactor.scan")}</p>
          <div className="mt-3 flex flex-wrap items-start gap-4">
            <div
              role="img"
              aria-label={t("account.twoFactor.qrLabel")}
              className="bg-qr-paper shrink-0 rounded-md p-1 [&>svg]:block [&>svg]:size-44"
              dangerouslySetInnerHTML={{ __html: enrolment.qrSvg }}
            />
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">{t("account.twoFactor.secret")}</p>
              <code
                data-testid="two-factor-secret"
                className="bg-card mt-1 block rounded-md p-2 font-mono text-xs break-all"
              >
                {enrolment.secret}
              </code>
            </div>
          </div>
          <BackupCodes codes={enrolment.backupCodes} />
          <ZodForm className="mt-4" fieldErrors={of("twoFactorConfirm")?.fieldErrors}>
            <input type="hidden" name="intent" value="twoFactorConfirm" />
            <FormField name="code" label={t("account.twoFactor.code")}>
              <Input
                name="code"
                required
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
              />
            </FormField>
            <Button type="submit">{t("account.twoFactor.confirm")}</Button>
          </ZodForm>
        </div>
      ) : (
        <ZodForm className="mt-4" fieldErrors={of("twoFactorStart")?.fieldErrors}>
          <input type="hidden" name="intent" value="twoFactorStart" />
          <FormField name="password" label={t("account.twoFactor.password")}>
            <Input name="password" type="password" required autoComplete="current-password" />
          </FormField>
          <Button type="submit">{t("account.twoFactor.start")}</Button>
        </ZodForm>
      )}

      <h2 className="mt-8 text-base font-semibold">{t("account.password.heading")}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{t("account.password.intro")}</p>
      {changed ? (
        <p role="status" className="bg-status-info/15 text-foreground mt-4 rounded-lg p-3 text-sm">
          {t("account.password.changed")}
        </p>
      ) : null}
      <ZodForm ref={formRef} className="mt-4" fieldErrors={of("password")?.fieldErrors}>
        <FormField name="currentPassword" label={t("account.password.current")}>
          <Input name="currentPassword" type="password" required autoComplete="current-password" />
        </FormField>
        <FormField name="newPassword" label={t("account.password.new")}>
          <Input name="newPassword" type="password" required autoComplete="new-password" />
        </FormField>
        <FormField name="confirm" label={t("account.password.confirm")}>
          <Input name="confirm" type="password" required autoComplete="new-password" />
        </FormField>
        <Button type="submit">{t("account.password.submit")}</Button>
      </ZodForm>

      <NotificationEmailPreferences
        optOuts={loaderData.notificationEmailOptOuts}
        changed={of("notificationEmail")?.changed}
      />
      <PersonalAccessTokens
        mcpUrl={loaderData.mcpUrl}
        tokens={loaderData.tokens}
        userId={user.id}
        isAdmin={user.role === "ADMIN" && !loaderData.twoFactorRequired}
        result={result}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };

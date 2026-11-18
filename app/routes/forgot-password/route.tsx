import { data, Form, Link, redirect, useNavigation } from "react-router";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import type { Route } from "./+types/route";
import { buttonVariants } from "~/components/ui/button";
import { fieldClassName } from "~/components/ui/input";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import { accountMailReady, requestEmailPasswordReset } from "~/domains/auth/account-mail.server";
import { safeParseForm, z } from "~/lib/validation.server";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

const schema = z.object({
  email: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
});
const uncached = { headers: { "Cache-Control": "no-store" } };
export const headers = () => uncached.headers;

export async function loader() {
  if (!(await accountMailReady())) throw redirect("/login");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new Response(null, { status: 403 });
  }
  if (!(await accountMailReady())) return redirect("/login");
  const parsed = await safeParseForm(request, schema);
  if (!parsed.success) return data({ invalid: true }, { ...uncached, status: 422 });
  await requestEmailPasswordReset(parsed.data.email, request);
  return data({ sent: true }, uncached);
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "auth.forgot.title") }];
}

export default function ForgotPassword({ actionData }: Route.ComponentProps) {
  const t = useT();
  const busy = useNavigation().state !== "idle";
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LanguageSwitcher className="absolute top-4 right-4" />
      <section className="bg-card text-card-foreground shadow-surface-3 w-full max-w-sm rounded-xl p-6">
        <h1 className="text-xl font-bold">{t("auth.forgot.heading")}</h1>
        {actionData && "sent" in actionData ? (
          <p role="status" className="mt-2 text-sm">
            {t("auth.forgot.sent")}
          </p>
        ) : (
          <>
            <p className="text-muted-foreground mt-2 text-sm">{t("auth.forgot.intro")}</p>
            <Form action="/forgot-password" method="post" className="mt-4 flex flex-col gap-4">
              <Field name="email" className="space-y-1">
                <FieldLabel className="text-sm">{t("auth.login.email")}</FieldLabel>
                <Input
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="username"
                  spellCheck={false}
                  className={`${fieldClassName} h-control px-control`}
                />
              </Field>
              {actionData && "invalid" in actionData ? (
                <p role="alert" className="text-destructive text-sm">
                  {t("auth.forgot.invalid")}
                </p>
              ) : null}
              <Button type="submit" className={buttonVariants()} disabled={busy}>
                {t("auth.forgot.submit")}
              </Button>
            </Form>
          </>
        )}
        <Link to="/login" className="mt-4 block text-sm underline underline-offset-4">
          {t("auth.forgot.back")}
        </Link>
      </section>
    </main>
  );
}

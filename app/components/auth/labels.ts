import type { UserRole } from "~/generated/prisma/client";
import { t } from "~/i18n";
import type { Locale } from "~/i18n/locales";

export function roleLabel(locale: Locale, role: UserRole): string {
  return t(locale, `auth.role.${role}`);
}

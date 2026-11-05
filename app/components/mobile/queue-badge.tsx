import { Link } from "react-router";
import { CloudOff } from "lucide-react";
import { useT } from "~/i18n/use-t";

const PILL =
  "bg-status-warning/15 nums flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold";

/**
 * Header badge for captures waiting on this device. Normally a plain counter;
 * once the session has expired it is the way back to sign-in. The link keeps
 * the pill's look but carries the 44 px touch area, and both variants name what
 * the number counts, since the number alone says nothing to a screen reader.
 */
export function QueueBadge({ pending, authRequired }: { pending: number; authRequired: boolean }) {
  const t = useT();
  if (pending <= 0) return null;
  if (authRequired) {
    const label = t("mobile.badge.signIn", { count: pending });
    return (
      <Link
        to="/login?next=%2Fm"
        aria-label={label}
        title={label}
        className="flex min-h-11 items-center"
      >
        <span className={PILL}>
          <CloudOff className="size-3.5" strokeWidth={2} aria-hidden />
          {pending}
          <span>{t("mobile.capture.signInAction")}</span>
        </span>
      </Link>
    );
  }
  const label = t("mobile.badge.pending", { count: pending });
  return (
    <span role="status" aria-label={label} title={label} className={PILL}>
      <CloudOff className="size-3.5" strokeWidth={2} aria-hidden />
      {pending}
    </span>
  );
}

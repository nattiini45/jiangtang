import { Link } from "react-router";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDateTime } from "~/i18n/format";
import { actionLabel } from "~/components/history/labels";
import type { listHomeChanges } from "~/domains/dashboard/home-activity.queries.server";

export function HomeChanges({
  data,
  mobile = false,
}: {
  data: Awaited<ReturnType<typeof listHomeChanges>>;
  mobile?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const prefix = mobile ? "/m" : "";
  return (
    <div className={mobile ? "space-y-4 p-4" : "space-y-5"}>
      <Link to={mobile ? "/m" : "/"} className="text-sm underline underline-offset-4">
        {t("nav.overview")}
      </Link>
      <h1 className="text-xl font-bold">{t("dashboard.home.activity.title")}</h1>
      {!data.items.length ? (
        <p className="text-sm text-muted-foreground">{t("dashboard.home.activity.empty")}</p>
      ) : (
        <ul className="divide-y rounded-lg bg-card p-4 shadow-surface-2">
          {data.items.map((entry) => (
            <li key={entry.id} className="min-w-0 py-3">
              <p className="mb-1 text-xs text-muted-foreground">
                {actionLabel(locale, entry.action)} · {formatDateTime(locale, entry.occurredAt)}
              </p>
              <Link
                to={`${prefix}${entry.href}`}
                className="block min-w-0 truncate underline-offset-4 hover:underline"
                title={entry.title}
              >
                {entry.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.nextCursor ? (
        <Link
          to={`?cursor=${encodeURIComponent(data.nextCursor)}`}
          className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
        >
          {t("activity.loadOlder")}
        </Link>
      ) : null}
    </div>
  );
}

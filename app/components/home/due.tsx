import { Link } from "react-router";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDate, formatDateTime } from "~/i18n/format";
import type { getHomeDue } from "~/domains/dashboard/home.queries.server";
import { ReadingDueRows } from "~/components/inventory/readings";
import { PlanDueRows } from "~/components/plans/plans";
const LINK =
  "min-w-0 truncate underline-offset-4 decoration-(--input) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
function Rows({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y">{children}</ul>;
}
export function DueItems({
  due,
  mobile = false,
  limit = Infinity,
  headingLevel = 3,
}: {
  due: Awaited<ReturnType<typeof getHomeDue>>;
  mobile?: boolean;
  limit?: number;
  headingLevel?: 2 | 3;
}) {
  const t = useT();
  const locale = useLocale();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const path = (href: string) => (mobile ? `/m${href}` : href);
  const roomPath = (slug: string) => `${path(`/rooms/${slug}`)}#functions`;
  const more = (total: number, shown: number) =>
    total > shown ? (
      <p className="mt-2 text-xs text-muted-foreground">
        {t("dashboard.home.more", { count: total - shown })}
      </p>
    ) : null;
  const empty = () => (
    <p className="text-sm text-muted-foreground">{t("dashboard.home.due.empty")}</p>
  );
  return (
    <>
      {!due.roundCount &&
      !due.overrideCount &&
      !due.confirmationCount &&
      !due.readings.length &&
      !due.plans.length ? (
        empty()
      ) : (
        <>
          {due.plans.length ? (
            <div className="mb-3">
              <Heading className="text-sm font-semibold">{t("plans.title")}</Heading>
              <PlanDueRows rows={due.plans.slice(0, limit)} mobile={mobile} />
              {more(due.plans.length, Math.min(limit, due.plans.length))}
            </div>
          ) : null}
          {due.readings.length ? (
            <div className="mb-3">
              <Heading className="text-sm font-semibold">{t("readings.dueHeading")}</Heading>
              <ReadingDueRows rows={due.readings.slice(0, limit)} mobile={mobile} />
              {more(due.readings.length, Math.min(limit, due.readings.length))}
            </div>
          ) : null}
          {due.roundCount ? (
            <div className="mb-3">
              <Heading className="text-sm font-semibold">{t("functions.rounds.title")}</Heading>
              <Rows>
                {due.rounds.slice(0, limit).map((round) => (
                  <li key={round.id} className="py-2">
                    <Link
                      className={`${LINK} block`}
                      to={path(`/rounds/${round.id}`)}
                      title={round.name}
                    >
                      {round.name}
                    </Link>
                    <p className="nums text-xs text-muted-foreground">
                      {t("dashboard.home.progress", { done: round.done, total: round.total })}
                    </p>
                  </li>
                ))}
              </Rows>
              {more(due.roundCount, Math.min(limit, due.rounds.length))}
            </div>
          ) : null}
          {due.overrideCount ? (
            <div className="mb-3">
              <Heading className="text-sm font-semibold">
                {t("dashboard.home.overrides", { count: due.overrideCount })}
              </Heading>
              <Rows>
                {due.overrides.slice(0, limit).map((row) => (
                  <li key={row.id} className="py-2">
                    <Link
                      to={roomPath(row.slug)}
                      className={`${LINK} block`}
                      title={`${row.room} · ${row.name}`}
                    >
                      {row.room} · {row.name}
                    </Link>
                    <p
                      className={`text-xs ${row.expired ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {t(row.expired ? "dashboard.home.expired" : "dashboard.home.ends", {
                        date: formatDateTime(locale, row.until),
                      })}
                    </p>
                  </li>
                ))}
              </Rows>
              {more(due.overrideCount, Math.min(limit, due.overrides.length))}
            </div>
          ) : null}
          {due.confirmationCount ? (
            <div>
              <Heading className="text-sm font-semibold">
                {t("dashboard.home.confirmations", { count: due.confirmationCount })}
              </Heading>
              <Rows>
                {due.confirmations.slice(0, limit).map((row) => (
                  <li key={row.id} className="py-2">
                    <Link
                      to={roomPath(row.slug)}
                      className={`${LINK} block`}
                      title={`${row.room} · ${row.name}`}
                    >
                      {row.room} · {row.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {t("dashboard.home.ends", { date: formatDate(locale, row.expiresAt) })}
                    </p>
                  </li>
                ))}
              </Rows>
              {more(due.confirmationCount, Math.min(limit, due.confirmations.length))}
            </div>
          ) : null}
        </>
      )}
      <Link
        to={path(Number.isFinite(limit) ? "/due" : "/rounds")}
        className={`${LINK} mt-3 inline-block text-sm`}
      >
        {t(Number.isFinite(limit) ? "dashboard.home.due.link" : "functions.rounds.title")}
      </Link>
      <Link to={path("/plans")} className={`${LINK} ms-4 mt-3 inline-block text-sm`}>
        {t("plans.title")}
      </Link>
    </>
  );
}
export function DuePage({
  due,
  mobile = false,
}: {
  due: Awaited<ReturnType<typeof getHomeDue>>;
  mobile?: boolean;
}) {
  const t = useT();
  return (
    <div className={mobile ? "space-y-4 p-4" : "space-y-5"}>
      <Link
        to={mobile ? "/m" : "/"}
        className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
      >
        {t("nav.overview")}
      </Link>
      <h1 className="text-xl font-bold">{t("dashboard.home.due.title")}</h1>
      <div className="min-w-0 rounded-lg bg-card p-4 shadow-surface-2">
        <DueItems due={due} mobile={mobile} headingLevel={2} />
      </div>
    </div>
  );
}

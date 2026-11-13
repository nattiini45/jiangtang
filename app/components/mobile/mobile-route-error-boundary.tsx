import { isRouteErrorResponse, Link, useLocation, useRouteError } from "react-router";
import { Button } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";

export function MobileRouteErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();
  const t = useT();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const missing = status === 404;
  const detail =
    isRouteErrorResponse(error) &&
    status < 500 &&
    !missing &&
    typeof error.data?.message === "string"
      ? error.data.message
      : t(missing ? "mobile.error.missingBody" : "mobile.error.failedBody");

  return (
    <div className="flex min-h-[40vh] items-center justify-center px-4 py-8">
      <section
        role="alert"
        className="bg-card shadow-surface-2 flex w-full max-w-md flex-col gap-3 rounded-lg p-4"
      >
        <h1 className="text-lg font-bold">
          {t(missing ? "mobile.error.missingTitle" : "mobile.error.failedTitle")}
        </h1>
        <p className="text-muted-foreground">{detail}</p>
        <p className="text-muted-foreground nums text-xs">{t("common.error.status", { status })}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild className="min-h-11">
            <Link to="/m/quick-entry">{t("mobile.error.capture")}</Link>
          </Button>
          {!missing ? (
            <Button asChild variant="secondary" className="min-h-11">
              <Link to={`${location.pathname}${location.search}`} reloadDocument>
                {t("mobile.error.retry")}
              </Link>
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

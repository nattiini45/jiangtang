import { isRouteErrorResponse, useRouteError } from "react-router";
import { useT } from "~/i18n/use-t";

/**
 * Shared route ErrorBoundary. Tracks re-export this as
 * their route `ErrorBoundary` (or wrap it). Renders thrown Responses with their
 * status; in dev, surfaces the error message.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const t = useT();

  let status = 500;
  let title = t("common.error.title");
  let detail = t("common.error.unexpected");

  if (isRouteErrorResponse(error)) {
    status = error.status;
    title = `${error.status}`;
    detail = error.statusText || (typeof error.data === "string" ? error.data : detail);
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
  }

  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <div className="bg-card text-card-foreground shadow-surface-2 flex max-w-md flex-col gap-2 rounded-lg p-6">
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="text-muted-foreground">{detail}</p>
        <p className="text-muted-foreground nums text-xs">{t("common.error.status", { status })}</p>
      </div>
    </div>
  );
}

import { isRouteErrorResponse, useRouteError } from "react-router";
import { useT } from "~/i18n/use-t";

/**
 * Shared route ErrorBoundary in the industrial style. Tracks re-export this as
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
      <div className="border-border bg-card text-card-foreground max-w-md border p-6">
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
          {t("common.error.status", { status })}
        </p>
        <h1 className="mt-2 font-mono text-2xl">{title}</h1>
        <p className="text-muted-foreground mt-2 text-sm">{detail}</p>
      </div>
    </div>
  );
}

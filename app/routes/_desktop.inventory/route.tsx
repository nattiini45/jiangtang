import { Outlet } from "react-router";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

// Transparent section layout for /inventory/* — renders children in the AppShell
// Outlet and provides the section-level error boundary. Pages live in the
// _index / nested route modules.
export default function InventoryLayout() {
  return <Outlet />;
}

export { RouteErrorBoundary as ErrorBoundary };

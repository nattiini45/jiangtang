import { Outlet } from "react-router";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

// Transparent section layout for /tickets/* (list, new, detail).
export default function TicketsLayout() {
  return <Outlet />;
}

export { RouteErrorBoundary as ErrorBoundary };

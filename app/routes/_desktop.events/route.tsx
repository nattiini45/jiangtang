import { Outlet } from "react-router";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

// Transparent section layout for /events/* (list, new, detail).
export default function EventsLayout() {
  return <Outlet />;
}

export { RouteErrorBoundary as ErrorBoundary };

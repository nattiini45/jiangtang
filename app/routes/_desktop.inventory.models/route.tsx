import { Outlet } from "react-router";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

// Transparent layout for /inventory/models/* (list, new, detail).
export default function ModelsLayout() {
  return <Outlet />;
}

export { RouteErrorBoundary as ErrorBoundary };

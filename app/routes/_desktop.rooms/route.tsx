import { Outlet } from "react-router";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

// Transparent section layout for /rooms/* (list, new, detail, edit, clone, import).
export default function RoomsLayout() {
  return <Outlet />;
}

export { RouteErrorBoundary as ErrorBoundary };

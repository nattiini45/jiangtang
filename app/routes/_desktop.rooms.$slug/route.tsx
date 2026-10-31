import { Outlet } from "react-router";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

// Transparent layout for /rooms/:slug/* (dashboard index, edit, clone).
export default function RoomDetailLayout() {
  return <Outlet />;
}

export { RouteErrorBoundary as ErrorBoundary };

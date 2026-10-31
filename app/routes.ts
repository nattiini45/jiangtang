import { type RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// Filesystem routing — the single source of truth for the route table.
// HARD RULE: never edit this file; tracks add route files under
// their owned subtree. flatRoutes() discovers everything under app/routes/.
export default flatRoutes() satisfies RouteConfig;

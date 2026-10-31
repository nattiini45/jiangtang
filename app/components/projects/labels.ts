import { ProjectStatus } from "~/generated/prisma/enums";

// The label function itself lives in `~/lib/status` (client-safe, shared with the domain
// layer). Re-exported so UI imports stay in the components namespace.
export { projectStatusLabel } from "~/lib/status";

/** All eight values in schema order — for selects and filter rows. */
export const PROJECT_STATUSES = Object.values(ProjectStatus);

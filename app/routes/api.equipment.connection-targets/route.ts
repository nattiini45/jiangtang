import { z } from "zod";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import {
  listConnectionTargets,
  freeConnectionPorts,
} from "~/domains/inventory/inventory.connections.queries.server";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  try {
    const input = z
      .object({
        equipmentId: z.string().min(1),
        q: z.string().max(120).default(""),
        target: z.string().min(1).optional(),
      })
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      input.target
        ? await freeConnectionPorts(input.equipmentId, input.target)
        : { devices: await listConnectionTargets(input.equipmentId, input.q) },
    );
  } catch (error) {
    throw toErrorResponse(error);
  }
}

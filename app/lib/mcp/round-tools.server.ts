import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import { registerTool } from "./tools.server";
import { mcpActor, type McpContext } from "./types.server";
import {
  startRound,
  recordCheck,
  setFunctionState,
  clearFunctionState,
} from "~/domains/functions/rounds.mutations.server";
import { getRound } from "~/domains/functions/rounds.queries.server";
import {
  startRoundSchema,
  recordCheckSchema,
  functionStateSchema,
} from "~/domains/functions/rounds.schema";

const target = z.object({ roomId: z.string().min(1), functionKey: z.string().min(1) });
async function functionId(key: string) {
  const fn =
    (await db.roomFunction.findUnique({ where: { systemKey: key } })) ??
    (await db.roomFunction.findUnique({ where: { id: key } }));
  if (!fn) throw new NotFoundError();
  return fn.id;
}

export function registerRoundTools(server: McpServer, context: McpContext) {
  registerTool(
    server,
    context,
    {
      name: "start_round",
      description:
        "Start a round for an explicit list of room IDs. Checklists come from each room's current functions.",
      schema: startRoundSchema,
      write: true,
    },
    (input, ctx) => startRound(mcpActor(ctx), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_round",
      description: "Read a round's rooms, completed/open progress, checks and faults.",
      schema: z.object({ id: z.string().min(1) }),
    },
    async ({ id }) => {
      const round = await getRound(id);
      if (!round) throw new NotFoundError();
      return round;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "record_check",
      description:
        "Record a human check. A failed/limited check opens a fault atomically. Round retries return the existing result. WORKS does not resolve evidence unless resolveFaults with resolution or restoreDevices are explicitly supplied.",
      schema: recordCheckSchema
        .omit({ functionId: true })
        .extend({ functionKey: z.string().min(1) }),
      write: true,
    },
    async ({ functionKey, ...input }, ctx) =>
      recordCheck(mcpActor(ctx), { ...input, functionId: await functionId(functionKey) }),
  );
  registerTool(
    server,
    context,
    {
      name: "set_function_state",
      description:
        "Admin: set a function state with a reason and optional ISO end instant. Newer evidence ends its effect.",
      schema: functionStateSchema.omit({ functionId: true, until: true }).extend({
        functionKey: z.string().min(1),
        until: z.iso.datetime({ offset: true }).optional(),
      }),
      role: "ADMIN",
      write: true,
    },
    async ({ functionKey, ...input }, ctx) =>
      setFunctionState(mcpActor(ctx), { ...input, functionId: await functionId(functionKey) }),
  );
  registerTool(
    server,
    context,
    {
      name: "clear_function_state",
      description: "Admin: end the state set by hand and use the computed state again.",
      schema: target,
      role: "ADMIN",
      write: true,
    },
    async ({ roomId, functionKey }, ctx) =>
      clearFunctionState(mcpActor(ctx), roomId, await functionId(functionKey)),
  );
}

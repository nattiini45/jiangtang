import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import { registerTool } from "./tools.server";
import { mcpActor, type McpContext } from "./types.server";
import { listRoomTypes } from "~/domains/rooms/room-types.queries.server";
import { setRoomType, setFunctionExpected } from "~/domains/rooms/room-types.mutations.server";

export function registerRoomTypeTools(server: McpServer, context: McpContext) {
  registerTool(
    server,
    context,
    {
      name: "list_room_types",
      description:
        "Read room types and their expected function IDs. Types are data, not fixed categories.",
      schema: z.object({}),
    },
    () => listRoomTypes(),
  );
  registerTool(
    server,
    context,
    {
      name: "set_room_type",
      description:
        "Assign a room type by library key or ID, or null to remove it. Per-room adjustments are preserved.",
      schema: z.object({ roomId: z.string().min(1), type: z.string().min(1).nullable() }),
      write: true,
    },
    async ({ roomId, type }, ctx) => {
      const row = type
        ? ((await db.roomType.findUnique({ where: { systemKey: type } })) ??
          (await db.roomType.findUnique({ where: { id: type } })))
        : null;
      if (type && !row) throw new NotFoundError();
      return setRoomType(mcpActor(ctx), { roomIds: [roomId], roomTypeId: row?.id ?? null });
    },
  );
  registerTool(
    server,
    context,
    {
      name: "set_function_expected",
      description:
        "Add or drop a room's expected function, with an optional note. Null restores inheritance from its type or devices.",
      schema: z.object({
        roomId: z.string().min(1),
        functionKey: z.string().min(1),
        expected: z.boolean().nullable(),
        note: z.string().trim().max(1000).optional(),
      }),
      write: true,
    },
    async ({ roomId, functionKey, ...input }, ctx) => {
      const fn =
        (await db.roomFunction.findUnique({ where: { systemKey: functionKey } })) ??
        (await db.roomFunction.findUnique({ where: { id: functionKey } }));
      if (!fn) throw new NotFoundError();
      return setFunctionExpected(mcpActor(ctx), roomId, { ...input, functionId: fn.id });
    },
  );
}

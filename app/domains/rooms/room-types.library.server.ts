import { txWithAudit, type AuditFn } from "~/lib/audit.server";
import type { Tx } from "~/lib/db.server";
import { workspaceLocale } from "~/i18n/locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import library from "~/lib/equipment-kinds/library.json" with { type: "json" };
import { reconcileFunctionsInTx } from "~/domains/functions/functions.library.server";
import { legacyFunctionFlags } from "~/domains/functions/functions.expectations";
import { recordLibraryStepInTx } from "~/lib/custom-fields/library-state.server";

export async function reconcileRoomTypesInTx(tx: Tx, audit: AuditFn) {
  await reconcileFunctionsInTx(tx, audit, true);
  const functions = await tx.roomFunction.findMany();
  for (const definition of library.roomTypes) {
    if (await tx.roomType.findUnique({ where: { systemKey: definition.key } })) continue;
    const row = await tx.roomType.create({
      data: {
        systemKey: definition.key,
        name: definition[workspaceLocale()],
        position: definition.position,
        functions: {
          create: definition.functions.map((key) => {
            const fn = functions.find((fn) => fn.systemKey === key);
            if (!fn) throw new Error(`Unknown room function ${key}`);
            return { functionId: fn.id };
          }),
        },
      },
    });
    await audit({
      action: "RoomTypeReconciled",
      entityType: "roomType",
      entityId: row.id,
      data: { systemKey: row.systemKey },
    });
  }
  const key = "room-function-expectations";
  if (await tx.libraryState.findUnique({ where: { key } })) return [];
  const copied: string[] = [];
  for (const room of await tx.room.findMany()) {
    const data = Object.entries(legacyFunctionFlags).flatMap(([key, flag]) => {
      const fn = functions.find((fn) => fn.systemKey === key);
      return room[flag] && fn ? [{ roomId: room.id, functionId: fn.id, expected: true }] : [];
    });
    const result = await tx.roomFunctionExpectation.createMany({ data, skipDuplicates: true });
    if (result.count) {
      copied.push(room.id);
      await audit({
        action: "RoomExpectationsCopied",
        entityType: "room",
        entityId: room.id,
        data: { count: result.count },
      });
    }
  }
  await recordLibraryStepInTx(tx, key, 1);
  return copied;
}

export async function reconcileRoomTypes() {
  const rooms = await txWithAudit({ name: "Jiangtang" }, reconcileRoomTypesInTx, {
    timeout: 30000,
  });
  await emitChange({ entityType: "roomType", id: "library", op: "updated" });
  for (const id of rooms) await emitChange({ entityType: "room", id, op: "updated" });
}

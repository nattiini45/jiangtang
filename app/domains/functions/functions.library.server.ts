import library from "~/lib/equipment-kinds/library.json" with { type: "json" };
import type { Tx } from "~/lib/db.server";
import type { AuditFn } from "~/lib/audit.server";
import { workspaceLocale } from "~/i18n/locale.server";

export async function reconcileFunctionsInTx(tx: Tx, audit: AuditFn, includeExpected = false) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('room-functions'))::text`;
  const kinds = await tx.equipmentKind.findMany({ where: { systemKey: { not: null } } });
  for (const definition of library.functions) {
    if (
      !includeExpected &&
      !kinds.some((kind) => !kind.archivedAt && definition.carriers.includes(kind.systemKey!))
    )
      continue;
    let row = await tx.roomFunction.findUnique({ where: { systemKey: definition.key } });
    const created = !row;
    if (!row) {
      row = await tx.roomFunction.create({
        data: {
          systemKey: definition.key,
          name: definition[workspaceLocale()],
          position: definition.position,
        },
      });
    }
    let changed = created;
    for (const kind of kinds) {
      const role = definition.carriers.includes(kind.systemKey!)
        ? "CARRIER"
        : definition.paths.includes(kind.systemKey!)
          ? "PATH"
          : null;
      if (role) {
        const result = await tx.roomFunctionKind.createMany({
          data: [{ functionId: row.id, kindId: kind.id, role }],
          skipDuplicates: true,
        });
        changed ||= result.count > 0;
      }
    }
    if (changed)
      await audit({
        action: "RoomFunctionReconciled",
        entityType: "roomFunction",
        entityId: row.id,
        data: { systemKey: row.systemKey },
      });
  }
}

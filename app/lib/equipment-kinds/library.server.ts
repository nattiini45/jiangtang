import { z } from "zod";
import { msgKey } from "~/i18n";
import library from "~/lib/equipment-kinds/library.json" with { type: "json" };
import { db, type Tx } from "~/lib/db.server";
import type { AuditActor, AuditFn } from "~/lib/audit.server";
import { workspaceLocale } from "~/i18n/locale.server";
import { tr } from "~/i18n/request-locale.server";
import { ValidationError } from "~/lib/errors.server";
import { checkStructureLimit, KIND_LIMIT, structureWrite } from "./structure.server";
import { reconcileLibraryInTx } from "~/lib/custom-fields/library.server";
import { emitChange } from "~/lib/realtime/emit.server";

export async function ensureLibraryPartKindsInTx(tx: Tx, audit: AuditFn, keys: string[]) {
  let installed = false;
  for (const key of new Set(keys)) {
    if (await tx.equipmentKind.findUnique({ where: { systemKey: key } })) continue;
    const definition = library.kinds.find((kind) => kind.key === key);
    if (!definition || !library.partKinds.includes(key))
      throw new ValidationError({}, [tr("inventory.catalog.kindRequired")]);
    const group = await tx.equipmentFunctionGroup.findUniqueOrThrow({
      where: { systemKey: definition.group },
    });
    if (group.archivedAt) throw new ValidationError({}, [tr("inventory.catalog.kindRequired")]);
    await checkStructureLimit(tx, "kind");
    const position = await tx.equipmentKind.aggregate({
      where: { groupId: group.id },
      _max: { position: true },
    });
    const kind = await tx.equipmentKind.create({
      data: {
        systemKey: key,
        name: definition[workspaceLocale()],
        groupId: group.id,
        position: (position._max.position ?? -1) + 1,
      },
    });
    await audit({
      action: "EquipmentKindCreated",
      entityType: "equipmentKind",
      entityId: kind.id,
      data: { name: kind.name, libraryKey: key },
    });
    installed = true;
  }
  if (installed) await reconcileLibraryInTx(tx, audit);
}

export const libraryQuerySchema = z.object({
  institutionType: z
    .string()
    .optional()
    .refine(
      (value) => !value || library.institutionTypes.some((type) => type.key === value),
      msgKey("admin.structure.library.invalidInstitution"),
    ),
});
export const libraryInstallSchema = z.object({
  keys: z
    .array(z.string().min(1))
    .min(1, msgKey("admin.structure.library.invalidSelection"))
    .max(KIND_LIMIT, msgKey("admin.structure.library.invalidSelection"))
    .refine(
      (keys) => new Set(keys).size === keys.length,
      msgKey("admin.structure.library.invalidSelection"),
    ),
});

export async function listKindLibrary(
  institutionType?: string,
  tx: Pick<Tx, "equipmentKind" | "equipmentFunctionGroup"> = db,
) {
  libraryQuerySchema.parse({ institutionType });
  const locale = workspaceLocale();
  const existing = await tx.equipmentKind.findMany({
    select: { id: true, systemKey: true, name: true, archivedAt: true },
  });
  const groups = await tx.equipmentFunctionGroup.findMany({
    select: { id: true, systemKey: true, name: true, archivedAt: true },
  });
  const kinds = library.kinds
    .filter((kind) => !institutionType || kind.institution_types.includes(institutionType))
    .map((kind) => {
      const current = existing.find((row) => row.systemKey === kind.key);
      const taken = existing.some(
        (row) => !row.archivedAt && row.name.toLowerCase() === kind[locale].toLowerCase(),
      );
      const group = groups.find((row) => row.systemKey === kind.group);
      return {
        ...kind,
        installationName: kind[locale],
        installedId: current?.id ?? null,
        installedName: current?.name ?? null,
        groupArchived: !!group?.archivedAt,
        status: current
          ? current.archivedAt
            ? ("archived" as const)
            : ("present" as const)
          : taken
            ? ("taken" as const)
            : ("available" as const),
      };
    });
  return {
    institutionTypes: library.institutionTypes,
    functionGroups: library.functionGroups,
    kinds,
    remaining: KIND_LIMIT - existing.filter((kind) => !kind.archivedAt).length,
    installationLocale: locale,
  };
}

export async function installLibraryKinds(
  actor: AuditActor,
  input: z.input<typeof libraryInstallSchema>,
) {
  const { keys } = libraryInstallSchema.parse(input);
  const result = await structureWrite(
    "kind",
    actor,
    async (tx, audit) => {
      const snapshot = await listKindLibrary(undefined, tx);
      const selected = snapshot.kinds.filter((kind) => keys.includes(kind.key));
      const unavailable = selected
        .filter((kind) => kind.status !== "available" || kind.groupArchived)
        .map((kind) => kind.installationName);
      unavailable.push(...keys.filter((key) => !selected.some((kind) => kind.key === key)));
      if (unavailable.length)
        throw new ValidationError({
          keys: [tr("admin.structure.library.conflict", { names: unavailable.join(", ") })],
        });
      await checkStructureLimit(tx, "kind", selected.length);
      const installed = [];
      for (const definition of library.functionGroups) {
        const kinds = selected.filter((kind) => kind.group === definition.key);
        if (!kinds.length) continue;
        let group = await tx.equipmentFunctionGroup.findUnique({
          where: { systemKey: definition.key },
        });
        if (!group) {
          const name = definition[snapshot.installationLocale];
          const taken = await tx.equipmentFunctionGroup.findFirst({
            where: { name: { equals: name, mode: "insensitive" }, archivedAt: null },
          });
          if (taken)
            throw new ValidationError({
              keys: [
                tr("admin.structure.library.groupConflict", {
                  name,
                  kinds: kinds.map((kind) => kind.installationName).join(", "),
                }),
              ],
            });
          await checkStructureLimit(tx, "group");
          group = await tx.equipmentFunctionGroup.create({
            data: { systemKey: definition.key, name, position: definition.position },
          });
          await audit({
            action: "EquipmentFunctionGroupCreated",
            entityType: "equipmentFunctionGroup",
            entityId: group.id,
            data: { name: group.name, libraryKey: definition.key },
          });
        }
        const max = await tx.equipmentKind.aggregate({
          where: { groupId: group.id },
          _max: { position: true },
        });
        let position = (max._max.position ?? -1) + 1;
        for (const definition of kinds) {
          const kind = await tx.equipmentKind.create({
            data: {
              systemKey: definition.key,
              name: definition.installationName,
              groupId: group.id,
              position: position++,
              tracksFrequency: false,
            },
          });
          await audit({
            action: "EquipmentKindCreated",
            entityType: "equipmentKind",
            entityId: kind.id,
            data: { name: kind.name, groupId: group.id, libraryKey: definition.key },
          });
          installed.push(kind);
        }
      }
      await reconcileLibraryInTx(tx, audit);
      return { installed };
    },
    true,
  );
  await emitChange({ entityType: "customField", id: "library", op: "updated" });
  return result;
}

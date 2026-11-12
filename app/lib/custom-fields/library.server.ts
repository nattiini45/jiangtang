import type { Tx } from "~/lib/db.server";
import { txWithAudit, type AuditFn } from "~/lib/audit.server";
import { lockDefinitions, definitionInclude } from "~/lib/custom-fields/definitions.server";
import { deriveFieldKey } from "~/lib/custom-fields/admin";
import { emitChange } from "~/lib/realtime/emit.server";
import { workspaceLocale } from "~/i18n/locale.server";
import { propertyLibrary, type PropertyLibrary } from "~/lib/equipment-kinds/properties";
import { fieldType } from "./definitions.schema";

export async function reconcileLibraryInTx(
  tx: Tx,
  audit: AuditFn,
  library: PropertyLibrary = propertyLibrary,
) {
  await lockDefinitions(tx, true);
  const state = await tx.libraryState.findUnique({ where: { key: "library" } });
  if (state && state.version > library.version) return [];
  const refresh = !state || state.version < library.version;
  const locale = workspaceLocale();
  const properties = new Map(
    [...library.sharedProperties, ...library.properties].map((property) => [
      property.key,
      property,
    ]),
  );
  const kinds = await tx.equipmentKind.findMany({ where: { systemKey: { not: null } } });
  const fields = await tx.customField.findMany({
    where: { scope: "EQUIPMENT" },
    include: definitionInclude,
  });
  const keys = fields.map((field) => field.key);
  const changed = new Set<string>();
  for (const kind of kinds) {
    for (const key of library.kinds.find((entry) => entry.key === kind.systemKey)?.properties ??
      []) {
      const property = properties.get(key);
      if (!property) throw new Error(`Unknown library property ${key}`);
      if (!fieldType.safeParse(property.type).success)
        throw new Error(`Library property ${key} has an unsupported type`);
      const unit = library.units.find((unit) => unit.key === property.unit);
      const targetIds = kinds
        .filter((installed) =>
          library.kinds
            .find((entry) => entry.key === installed.systemKey)
            ?.properties?.includes(key),
        )
        .map((kind) => kind.id);
      let field = fields.find((row) => row.systemKey === key);
      if (field && (field.type !== property.type || field.level !== property.level))
        throw new Error(`Library property ${key} cannot change type or level`);
      if (!field) {
        field = fields.find(
          (row) =>
            !row.systemKey &&
            row.type === property.type &&
            (property.unit
              ? [property.unit, unit?.de, unit?.en].some(
                  (label) => label?.trim().toLowerCase() === row.unit?.trim().toLowerCase(),
                )
              : !row.unit?.trim()) &&
            row.kinds.length > 0 &&
            row.kinds.some((link) => link.kindId === kind.id) &&
            row.kinds.every((link) => targetIds.includes(link.kindId)) &&
            [property.de, property.en].some(
              (name) => name.toLowerCase() === row.name.toLowerCase(),
            ) &&
            row.options.every((option) =>
              property.options.some((entry) =>
                [entry.de, entry.en].some(
                  (label) => label.toLowerCase() === option.label.toLowerCase(),
                ),
              ),
            ) &&
            new Set(
              row.options.map(
                (option) =>
                  property.options.find((entry) =>
                    [entry.de, entry.en].some(
                      (label) => label.toLowerCase() === option.label.toLowerCase(),
                    ),
                  )?.key,
              ),
            ).size === row.options.length,
        );
        if (field) {
          Object.assign(
            field,
            await tx.customField.update({
              where: { id: field.id },
              data: { systemKey: key, level: property.level },
              include: definitionInclude,
            }),
          );
          for (const option of field.options) {
            const entry = property.options.find((entry) =>
              [entry.de, entry.en].some(
                (label) => label.toLowerCase() === option.label.toLowerCase(),
              ),
            )!;
            await tx.customFieldOption.update({
              where: { id: option.id },
              data: { systemKey: entry.key },
            });
          }
        } else {
          const fieldKey = deriveFieldKey(key, keys);
          keys.push(fieldKey);
          field = await tx.customField.create({
            data: {
              scope: "EQUIPMENT",
              key: fieldKey,
              systemKey: key,
              name: property[locale],
              type: property.type,
              level: property.level,
              unit: property.unit
                ? library.units.find((unit) => unit.key === property.unit)?.[locale]
                : null,
              position: fields.length,
              kinds: { create: { kindId: kind.id } },
            },
            include: definitionInclude,
          });
        }
        if (!fields.includes(field)) fields.push(field);
        changed.add(field.id);
      }
      if (!field.kinds.some((link) => link.kindId === kind.id)) {
        await tx.customFieldKind.create({ data: { fieldId: field.id, kindId: kind.id } });
        field.kinds.push({ fieldId: field.id, kindId: kind.id });
        changed.add(field.id);
      }
      if (refresh && !field.renamed && field.name !== property[locale]) {
        await tx.customField.update({ where: { id: field.id }, data: { name: property[locale] } });
        changed.add(field.id);
      }
      const options = await tx.customFieldOption.findMany({ where: { fieldId: field.id } });
      for (const [position, entry] of property.options.entries()) {
        if (!options.some((option) => option.systemKey === entry.key)) {
          await tx.customFieldOption.create({
            data: { fieldId: field.id, systemKey: entry.key, label: entry[locale], position },
          });
          changed.add(field.id);
        }
      }
    }
  }
  for (const id of changed)
    await audit({
      action: "LibraryPropertyReconciled",
      entityType: "customField",
      entityId: id,
      data: { version: library.version },
    });
  if (refresh)
    await tx.libraryState.upsert({
      where: { key: "library" },
      create: { key: "library", version: library.version },
      update: { version: library.version, appliedAt: new Date() },
    });
  return [...changed];
}

export async function reconcileLibrary(library: PropertyLibrary = propertyLibrary) {
  const changed = await txWithAudit(
    { name: "Jiangtang" },
    (tx, audit) => reconcileLibraryInTx(tx, audit, library),
    {
      timeout: 30000,
    },
  );
  if (changed.length) await emitChange({ entityType: "customField", id: "library", op: "updated" });
  return changed;
}

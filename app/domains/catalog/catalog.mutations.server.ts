import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import type { Tx } from "~/lib/db.server";
import { resolveEquipmentKind, type EquipmentKindInput } from "~/lib/equipment-kinds/kinds.server";
import type { EquipmentModel } from "~/generated/prisma/client";
import { modelExists } from "./catalog.queries.server";
import type { ModelCreateInput } from "./catalog.schema";

type ModelWriteInput = Omit<ModelCreateInput, "category"> & EquipmentKindInput;

/**
 * EquipmentModel mutations. Models have no status and an FK from Equipment blocks
 * hard-delete, so the catalog is create/edit only (retire-don't-delete).
 */

export async function createModel(
  actor: AuditActor,
  input: ModelWriteInput,
): Promise<EquipmentModel> {
  if (await modelExists(input.manufacturer ?? null, input.name)) {
    throw new ValidationError({ name: [tr("places.err.model.exists")] });
  }
  return txWithAudit(actor, async (tx, audit) => {
    const model = await tx.equipmentModel.create({
      data: {
        manufacturer: input.manufacturer ?? null,
        name: input.name,
        ...(await resolveEquipmentKind(tx, input)),
        specNotes: input.specNotes ?? null,
        manualUrl: input.manualUrl ?? null,
      },
    });
    await audit({
      action: "EquipmentModelCreated",
      entityType: "equipmentModel",
      entityId: model.id,
      data: { name: model.name, category: model.category },
    });
    return model;
  });
}

export async function updateModel(
  actor: AuditActor,
  id: string,
  input: ModelWriteInput,
): Promise<EquipmentModel> {
  if (await modelExists(input.manufacturer ?? null, input.name, id)) {
    throw new ValidationError({ name: [tr("places.err.model.nameTaken")] });
  }
  return txWithAudit(actor, async (tx, audit) => {
    const current = await tx.equipmentModel.findUniqueOrThrow({ where: { id } });
    const model = await tx.equipmentModel.update({
      where: { id },
      data: {
        manufacturer: input.manufacturer ?? null,
        name: input.name,
        ...(await resolveEquipmentKind(tx, input, current.kindId)),
        specNotes: input.specNotes ?? null,
        manualUrl: input.manualUrl ?? null,
      },
    });
    await audit({
      action: "EquipmentModelUpdated",
      entityType: "equipmentModel",
      entityId: model.id,
    });
    return model;
  });
}

// ── Find-or-create (for the CSV importer; runs inside the CALLER's tx) ──

/**
 * Find-or-create an `EquipmentModel` by name, auditing only when created.
 * Returns the id.
 *
 * The shape is `upsertCampus` / `upsertBuilding`
 * (`rooms.mutations.server.ts:106` / `:116`) — the corpus's own find-or-create —
 * used for the first time ACROSS a folder boundary, and for the same reason
 * the caller already owns a transaction, and the import's atomicity
 * is a guarantee the tree has today. Calling `createModel(actor, input)` instead
 * would satisfy the letter of "catalog/ owns the write" while opening a SECOND
 * `txWithAudit` on a second connection, so a CSV batch whose later row fails
 * would roll back its equipment rows and **keep** the model and its audit row —
 * orphans, committed, with a clean audit trail saying they were created.
 *
 * ⚠️ **The lookup is the load-bearing half, and it is `tx`-prefixed on purpose.**
 * It is tempting to build the find half on `modelExists`
 * (`catalog.queries.server.ts:116`) — same folder, already exported, and reusing
 * the owner's own helper is exactly what a builder-bypass rule *looks*
 * like. But `modelExists` reads `db.`, takes no `tx`, and matches
 * `manufacturer` **and** a case-**sensitive** `name`. A row written inside an open
 * transaction is invisible to a second connection, so row 2 of a batch would not
 * see the model row 1 created, would be told "absent", and would create a second
 * one — with every gate green. So the lookup below is `tx.`-prefixed and
 * case-insensitive, and `modelExists` is left untouched: `createModel` and
 * `updateModel` still call it, because a *manual* create is correctly deduped
 * against the whole `(manufacturer, name)` identity, while an import names only
 * a `name`.
 *
 * 🔴 **That asymmetry is why the database cannot back this lookup.** The only
 * unique object on the table is `EquipmentModel_manufacturer_name_key`, an index
 * on `(manufacturer, name)` — and the import writes no `manufacturer`, so it is
 * NULL on 100 % of imported models, where repeated NULLs are *distinct* to
 * Postgres. The index is also case-sensitive on both columns. So the
 * `mode: "insensitive"` name match below is STRICTER than the constraint on both
 * axes, and it is the only guard there is.
 *
 * ⚠️ **The audit payload is the import's, not `createModel`'s**, and that is
 * deliberate rather than an oversight: this writer exists for the importer,
 * so it keeps the `viaImport: true` flag the inline write carried. A
 * future caller that is NOT an import must not reuse it — it wants `createModel`,
 * which dedupes and reports the conflict instead of quietly reusing a row.
 */
export async function findOrCreateModel(
  tx: Tx,
  audit: AuditFn,
  input: { name: string } & EquipmentKindInput,
): Promise<string> {
  const existing = await tx.equipmentModel.findFirst({
    where: { name: { equals: input.name, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const model = await tx.equipmentModel.create({
    data: { name: input.name, ...(await resolveEquipmentKind(tx, input)) },
  });
  await audit({
    action: "EquipmentModelCreated",
    entityType: "equipmentModel",
    entityId: model.id,
    data: { name: model.name, viaImport: true },
  });
  return model.id;
}

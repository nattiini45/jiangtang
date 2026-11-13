import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { applyRoomCustomValuesInTx } from "./rooms.custom-values.server";
import { lockDefinitions } from "~/lib/custom-fields/definitions.server";
import { emitChange } from "~/lib/realtime/emit.server";
import type { Tx } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { ensureUniqueSlug } from "~/lib/slug.server";
import { createEquipmentInTx } from "~/domains/inventory/inventory.mutations.server";
import type { Building, Campus, Room, Prisma } from "~/generated/prisma/client";
import { buildingNameExists, campusNameExists } from "./rooms.queries.server";
import type {
  BuildingCreateInput,
  BuildingEditInput,
  CampusCreateInput,
  CampusEditInput,
  RoomCloneInput,
  RoomCreateInput,
  RoomCsvRow,
  RoomEditInput,
} from "./rooms.schema";

/**
 * Rooms-domain mutations. (Room create/edit/retire/clone/bulk are appended with
 * their steps.) Everything writes through txWithAudit so the audit row commits
 * with the change. Slugs are derived once and kept immutable (stable URLs).
 */

function campusSlugTaken(tx: Tx, slug: string): Promise<boolean> {
  return tx.campus.findFirst({ where: { slug }, select: { id: true } }).then((r) => r !== null);
}

// ── Campus ───────────────────────────────────────────────────────────────────

export async function createCampus(actor: AuditActor, input: CampusCreateInput): Promise<Campus> {
  if (await campusNameExists(input.name)) {
    throw new ValidationError({ name: [tr("places.err.campus.exists")] });
  }
  return txWithAudit(actor, async (tx, audit) => {
    const slug = await ensureUniqueSlug(input.name, (s) => campusSlugTaken(tx, s));
    let campus;
    try {
      campus = await tx.campus.create({ data: { name: input.name, slug } });
    } catch (e) {
      // Fast-path check above is TOCTOU-racy under concurrent requests; the
      // unique constraint is the real guard — map its violation to the same 422.
      if ((e as { code?: string }).code === "P2002") {
        throw new ValidationError({ name: [tr("places.err.campus.exists")] });
      }
      throw e;
    }
    await audit({
      action: "CampusCreated",
      entityType: "campus",
      entityId: campus.id,
      data: { name: campus.name },
    });
    return campus;
  });
}

export async function updateCampus(
  actor: AuditActor,
  id: string,
  input: CampusEditInput,
): Promise<Campus> {
  if (await campusNameExists(input.name, id)) {
    throw new ValidationError({ name: [tr("places.err.campus.nameTaken")] });
  }
  return txWithAudit(actor, async (tx, audit) => {
    const campus = await tx.campus.update({ where: { id }, data: { name: input.name } });
    await audit({ action: "CampusUpdated", entityType: "campus", entityId: campus.id });
    return campus;
  });
}

// ── Building ─────────────────────────────────────────────────────────────────

export async function createBuilding(
  actor: AuditActor,
  input: BuildingCreateInput,
): Promise<Building> {
  if (await buildingNameExists(input.campusId, input.name)) {
    throw new ValidationError({ name: [tr("places.err.building.existsAtCampus")] });
  }
  return txWithAudit(actor, async (tx, audit) => {
    let building;
    try {
      building = await tx.building.create({
        data: { campusId: input.campusId, name: input.name, code: input.code ?? null },
      });
    } catch (e) {
      // Fast-path check above is TOCTOU-racy under concurrent requests; the
      // @@unique([campusId, name]) constraint is the real guard.
      if ((e as { code?: string }).code === "P2002") {
        throw new ValidationError({ name: [tr("places.err.building.existsAtCampus")] });
      }
      throw e;
    }
    await audit({
      action: "BuildingCreated",
      entityType: "building",
      entityId: building.id,
      data: { name: building.name },
    });
    return building;
  });
}

export async function updateBuilding(
  actor: AuditActor,
  id: string,
  input: BuildingEditInput,
): Promise<Building> {
  if (await buildingNameExists(input.campusId, input.name, id)) {
    throw new ValidationError({
      name: [tr("places.err.building.nameTakenAtCampus")],
    });
  }
  return txWithAudit(actor, async (tx, audit) => {
    const building = await tx.building.update({
      where: { id },
      data: { campusId: input.campusId, name: input.name, code: input.code ?? null },
    });
    await audit({ action: "BuildingUpdated", entityType: "building", entityId: building.id });
    return building;
  });
}

// ── Upsert helpers (used by room create + bulk import; run inside the caller's tx) ──

/** Find-or-create a campus by name, auditing only when created. Returns the id. */
export async function upsertCampus(tx: Tx, audit: AuditFn, name: string): Promise<string> {
  const existing = await tx.campus.findFirst({ where: { name }, select: { id: true } });
  if (existing) return existing.id;
  const slug = await ensureUniqueSlug(name, (s) => campusSlugTaken(tx, s));
  const campus = await tx.campus.create({ data: { name, slug } });
  await audit({
    action: "CampusCreated",
    entityType: "campus",
    entityId: campus.id,
    data: { name },
  });
  return campus.id;
}

/** Find-or-create a building by (campusId, name), auditing only when created. */
export async function upsertBuilding(
  tx: Tx,
  audit: AuditFn,
  campusId: string,
  name: string,
  code?: string | null,
): Promise<string> {
  const existing = await tx.building.findFirst({ where: { campusId, name }, select: { id: true } });
  if (existing) return existing.id;
  const building = await tx.building.create({ data: { campusId, name, code: code ?? null } });
  await audit({
    action: "BuildingCreated",
    entityType: "building",
    entityId: building.id,
    data: { name },
  });
  return building.id;
}

// ── Room ─────────────────────────────────────────────────────────────────────

function roomSlugTaken(tx: Tx, slug: string): Promise<boolean> {
  return tx.room.findFirst({ where: { slug }, select: { id: true } }).then((r) => r !== null);
}

/**
 * Resolve campus/building, creating either from a typed name. A building's
 * campus is authoritative — but if the caller ALSO supplied an explicit
 * `campusId` that names a different campus, that's a contradictory/stale form
 * submission (e.g. the building select changed but the campus select didn't
 * update), not something to silently paper over by overriding it.
 */
async function resolveLocation(
  tx: Tx,
  audit: AuditFn,
  input: {
    campusId?: string;
    newCampusName?: string;
    buildingId?: string;
    newBuildingName?: string;
  },
): Promise<{ campusId: string | null; buildingId: string | null }> {
  let campusId: string | null = input.campusId ?? null;
  let buildingId: string | null = input.buildingId ?? null;

  if (!campusId && input.newCampusName)
    campusId = await upsertCampus(tx, audit, input.newCampusName);

  if (buildingId) {
    const b = await tx.building.findUnique({
      where: { id: buildingId },
      select: { campusId: true },
    });
    if (!b) throw new ValidationError({ buildingId: [tr("places.err.building.unknown")] });
    if (campusId && campusId !== b.campusId) {
      throw new ValidationError({
        campusId: [tr("places.err.building.campusMismatch")],
      });
    }
    campusId = b.campusId; // a building's campus is authoritative (when no conflicting campusId was given)
  } else if (input.newBuildingName) {
    if (!campusId)
      throw new ValidationError({ newBuildingName: [tr("places.err.building.needsCampus")] });
    buildingId = await upsertBuilding(tx, audit, campusId, input.newBuildingName);
  }
  return { campusId, buildingId };
}

/** Shared room column mapping (slug is set separately on create, never on update). */
function roomFields(
  input: RoomCreateInput,
  location: { campusId: string | null; buildingId: string | null },
) {
  return {
    name: input.name,
    roomNumber: input.roomNumber ?? null,
    campusId: location.campusId,
    buildingId: location.buildingId,
    capacity: input.capacity ?? null,
    owner: input.owner ?? null,
    status: input.status,
    hasProjector: input.hasProjector,
    hasMicrophony: input.hasMicrophony,
    hasBlackboard: input.hasBlackboard,
    hasWebConference: input.hasWebConference,
    hasAutoRecording: input.hasAutoRecording,
    mediaKeyRequired: input.mediaKeyRequired,
    videoInputs: input.videoInputs,
    audioOutputs: input.audioOutputs,
    bookingUrl: input.bookingUrl ?? null,
    manualUrl: input.manualUrl ?? null,
    virtualTourUrl: input.virtualTourUrl ?? null,
    tipsNotes: input.tipsNotes ?? null,
    knownIssues: input.knownIssues ?? null,
    lastCheckedAt: input.lastCheckedAt ?? null,
    renewalStatus: input.renewalStatus ?? null,
    renewalFrom: input.renewalFrom ?? null,
    renewalTo: input.renewalTo ?? null,
  };
}

export async function createRoom(actor: AuditActor, input: RoomCreateInput): Promise<Room> {
  return txWithAudit(actor, async (tx, audit) => {
    if (input.customValues !== undefined) await lockDefinitions(tx);
    const location = await resolveLocation(tx, audit, input);
    const slug = await ensureUniqueSlug(input.name, (s) => roomSlugTaken(tx, s));
    let room;
    try {
      room = await tx.room.create({ data: { slug, ...roomFields(input, location) } });
    } catch (e) {
      // ensureUniqueSlug's pre-check is TOCTOU-racy under concurrent requests;
      // the @unique(slug) constraint is the real guard.
      if ((e as { code?: string }).code === "P2002") {
        throw new ValidationError({
          name: [tr("places.err.room.justCreated")],
        });
      }
      throw e;
    }
    const custom =
      input.customValues === undefined
        ? {}
        : await applyRoomCustomValuesInTx(tx, room.id, input.customValues);
    if (input.customValues !== undefined)
      room = await tx.room.findUniqueOrThrow({ where: { id: room.id } });
    await audit({
      action: "RoomCreated",
      entityType: "room",
      entityId: room.id,
      data: { name: room.name, slug: room.slug, ...custom },
    });
    return room;
  });
}

export async function updateRoom(
  actor: AuditActor,
  id: string,
  input: RoomEditInput,
): Promise<Room> {
  return txWithAudit(actor, async (tx, audit) => {
    const data =
      input.customValues === undefined
        ? undefined
        : await applyRoomCustomValuesInTx(tx, id, input.customValues);
    const location = await resolveLocation(tx, audit, input);
    const room = await tx.room.update({ where: { id }, data: roomFields(input, location) });
    await audit({ action: "RoomUpdated", entityType: "room", entityId: room.id, data });
    return room;
  });
}

/** Retire (never delete — FK RESTRICT from bookings): status → OUT_OF_SERVICE. */
export async function retireRoom(actor: AuditActor, id: string): Promise<Room> {
  return txWithAudit(actor, async (tx, audit) => {
    const room = await tx.room.update({ where: { id }, data: { status: "OUT_OF_SERVICE" } });
    await audit({ action: "RoomRetired", entityType: "room", entityId: room.id });
    return room;
  });
}

export async function markRoomChecked(actor: AuditActor, id: string): Promise<Room> {
  const room = await txWithAudit(actor, (tx, audit) => markRoomCheckedInTx(tx, audit, id));
  await emitChange({ entityType: "room", id, op: "updated" });
  return room;
}

export async function markRoomCheckedInTx(tx: Tx, audit: AuditFn, id: string, now = new Date()) {
  const checked = await tx.room.update({ where: { id }, data: { lastCheckedAt: now } });
  await audit({
    action: "RoomChecked",
    entityType: "room",
    entityId: id,
    data: { lastCheckedAt: now.toISOString() },
  });
  return checked;
}

/**
 * Clone a room's setup into a brand-new room. Copies the chosen technical
 * aspects; recreates FIXED gear as a fresh unit (same kind/model, unit-specific
 * identifiers nulled); POOLED gear is skipped (it belongs to the pool). Room +
 * cloned equipment + audit commit or roll back together.
 */
export async function cloneRoom(
  actor: AuditActor,
  sourceSlug: string,
  input: RoomCloneInput,
): Promise<Room> {
  return txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx);
    const source = await tx.room.findUnique({
      where: { slug: sourceSlug },
      include: { equipment: true },
    });
    if (!source) throw new NotFoundError(tr("places.err.room.sourceNotFound"));

    const location = await resolveLocation(tx, audit, input);
    const slug = await ensureUniqueSlug(input.name, (s) => roomSlugTaken(tx, s));

    const room = await tx.room.create({
      data: {
        slug,
        name: input.name,
        roomNumber: input.roomNumber ?? null,
        campusId: location.campusId,
        buildingId: location.buildingId,
        status: "ALL_GOOD",
        hasProjector: input.copyFeatures ? source.hasProjector : false,
        hasMicrophony: input.copyFeatures ? source.hasMicrophony : false,
        hasBlackboard: input.copyFeatures ? source.hasBlackboard : false,
        hasWebConference: input.copyFeatures ? source.hasWebConference : false,
        hasAutoRecording: input.copyFeatures ? source.hasAutoRecording : false,
        mediaKeyRequired: input.copyFeatures ? source.mediaKeyRequired : false,
        videoInputs: input.copyCapabilities ? source.videoInputs : [],
        audioOutputs: input.copyCapabilities ? source.audioOutputs : [],
        tipsNotes: input.copyTips ? source.tipsNotes : null,
        customValues: source.customValues as Prisma.InputJsonObject,
      },
    });

    let copiedEquipment = 0;
    if (input.copyEquipment) {
      const fixedUnits = source.equipment.filter(
        (e) => e.mobility === "FIXED" && e.status !== "RETIRED",
      );
      for (const u of fixedUnits) {
        await createEquipmentInTx(tx, audit, {
          // The `Equipment` write belongs to `inventory/`: this
          // folder read-only imports the owner, and the owner's writer routes the
          // payload through `equipmentFields()` and appends one `EquipmentCreated`
          // row per unit, in THIS transaction. Every column omitted below is
          // written NULL by the builder, which is how the unit-specific
          // identifiers are cleared without a second hand-maintained column list.
          roomId: room.id,
          // Already resolved: the source unit's model id is carried across and
          // NOTHING here creates or resolves an `EquipmentModel`, so `catalog/`'s
          // writer set is identical before and after a clone.
          modelId: u.modelId ?? undefined,
          category: u.category,
          kindId: u.kindId ?? undefined,
          mobility: "FIXED",
          // Preserve the source unit's status (e.g. FAULTY/MAINTENANCE) — cloning
          // must not silently "fix" a broken unit by upgrading it to OPERATIONAL.
          status: u.status,
          name: u.name ?? undefined,
          // Kind/model-ish attributes carry over; unit identifiers (assetTag,
          // serial, hostname, IP, MAC, Dell tags, frequency, channel) do NOT.
          micKind: u.micKind ?? undefined,
          band: u.band ?? undefined,
          lampType: u.lampType ?? undefined,
          color: u.color ?? undefined,
          copiedValues: u.customValues as Prisma.InputJsonObject,
        });
        copiedEquipment++;
      }
    }

    await audit({
      action: "RoomCloned",
      entityType: "room",
      entityId: room.id,
      data: { fromId: source.id, fromSlug: source.slug, copiedEquipment },
    });
    return room;
  });
}

/**
 * Bulk-create rooms from validated CSV rows in ONE transaction (whole-batch
 * atomic — any failure rolls the whole import back). Campus/building are
 * upserted by name. Each room + each auto-created location is audited.
 */
export async function bulkCreateRooms(
  actor: AuditActor,
  rows: RoomCsvRow[],
): Promise<{ created: number; items: Pick<Room, "id" | "name" | "slug">[] }> {
  return txWithAudit(
    actor,
    async (tx, audit) => {
      if (rows.some((row) => row.customValues !== undefined)) await lockDefinitions(tx);
      const items: Pick<Room, "id" | "name" | "slug">[] = [];
      for (const row of rows) {
        let campusId: string | null = null;
        if (row.campusName) campusId = await upsertCampus(tx, audit, row.campusName);
        let buildingId: string | null = null;
        if (row.buildingName && campusId)
          buildingId = await upsertBuilding(tx, audit, campusId, row.buildingName);

        const slug = await ensureUniqueSlug(row.name, (s) => roomSlugTaken(tx, s));
        const room = await tx.room.create({
          data: {
            slug,
            name: row.name,
            roomNumber: row.roomNumber ?? null,
            campusId,
            buildingId,
            capacity: row.capacity ?? null,
            owner: row.owner ?? null,
            status: row.status,
            hasProjector: row.hasProjector,
            hasMicrophony: row.hasMicrophony,
            hasBlackboard: row.hasBlackboard,
            hasWebConference: row.hasWebConference,
            hasAutoRecording: row.hasAutoRecording,
            mediaKeyRequired: row.mediaKeyRequired,
            videoInputs: row.videoInputs,
            audioOutputs: row.audioOutputs,
            knownIssues: row.knownIssues ?? null,
            lastCheckedAt: row.lastCheckedAt ?? null,
          },
        });
        const custom =
          row.customValues === undefined
            ? {}
            : await applyRoomCustomValuesInTx(tx, room.id, row.customValues);
        await audit({
          action: "RoomCreated",
          entityType: "room",
          entityId: room.id,
          data: { name: room.name, slug: room.slug, viaImport: true, ...custom },
        });
        items.push({ id: room.id, name: room.name, slug: room.slug });
      }
      return { created: items.length, items };
    },
    // Dozens of sequential row round-trips in one tx can exceed Prisma's ~5s
    // default and abort with P2028 — give bulk imports generous headroom.
    { timeout: 30_000, maxWait: 10_000 },
  );
}

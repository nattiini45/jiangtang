import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { db } from "~/lib/db.server";
import { setStorageProvider } from "~/lib/storage/storage.server";
import { FsStorageProvider } from "~/lib/storage/fs-provider";
import {
  createAttachment,
  deleteAttachment,
} from "~/domains/attachments/attachments.mutations.server";

/**
 * Attachment mutations against the real encrypted-FS provider + DB: createAttachment
 * stores the bytes, writes the row + audit, and records dimensions; deleteAttachment
 * removes the row + audits it. ActivityLog is append-only (not cleaned).
 */

const RUN = `att_${Date.now()}`;
const actor = { id: null as string | null, name: "Attachment Tester", initials: "AT" };
const createdIds: string[] = [];
let storageDir = "";
let roomId = "";

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "jiangtang-att-"));
  setStorageProvider(new FsStorageProvider(storageDir));

  const campus = await db.campus.create({ data: { name: `${RUN}-Campus`, slug: `${RUN}-campus` } });
  const room = await db.room.create({
    data: {
      slug: `${RUN}-room`,
      name: `${RUN} Saal`,
      status: "ALL_GOOD",
      hasProjector: false,
      hasMicrophony: false,
      hasBlackboard: false,
      hasWebConference: false,
      hasAutoRecording: false,
      mediaKeyRequired: false,
      campusId: campus.id,
    },
  });
  roomId = room.id;
});

afterAll(async () => {
  await db.attachment.deleteMany({ where: { id: { in: createdIds } } });
  await db.room.deleteMany({ where: { id: roomId } });
  await db.campus.deleteMany({ where: { name: `${RUN}-Campus` } });
  await rm(storageDir, { recursive: true, force: true });
  await db.$disconnect();
});

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 9, channels: 3, background: { r: 5, g: 5, b: 5 } } })
    .jpeg()
    .toBuffer();
}

describe("attachment mutations", () => {
  it("stores bytes, writes the row + audit, and records dimensions", async () => {
    const att = await createAttachment(
      actor,
      { body: await jpeg(), contentType: "image/jpeg", filename: "raum.jpg" },
      { category: "ROOM", roomId, equipmentId: undefined, ticketId: undefined },
    );
    createdIds.push(att.id);

    expect(att.objectKey).toMatch(/\.jpg$/);
    expect(att.width).toBe(16);
    expect(att.height).toBe(9);
    expect(att.roomId).toBe(roomId);

    const logs = await db.activityLog.findMany({
      where: { entityType: "attachment", entityId: att.id, action: "AttachmentAdded" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorSnapshot).toMatchObject({ initials: "AT" });
  });

  it("deletes the row and audits the removal", async () => {
    const att = await createAttachment(
      actor,
      { body: await jpeg(), contentType: "image/jpeg", filename: "weg.jpg" },
      { category: "ROOM", roomId, equipmentId: undefined, ticketId: undefined },
    );
    await deleteAttachment(actor, att.id);

    const gone = await db.attachment.findUnique({ where: { id: att.id } });
    expect(gone).toBeNull();

    const logs = await db.activityLog.findMany({
      where: { entityType: "attachment", entityId: att.id, action: "AttachmentRemoved" },
    });
    expect(logs).toHaveLength(1);
  });
});

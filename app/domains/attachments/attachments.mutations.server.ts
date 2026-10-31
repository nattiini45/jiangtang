import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { NotFoundError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { getStorage, type StorageCategory } from "~/lib/storage/storage.server";
import type { Attachment, AttachmentCategory } from "~/generated/prisma/client";
import type { AttachmentUploadInput } from "./attachments.schema";

/**
 * Attachment mutations. Bytes go to the StorageProvider (which validates +
 * strips EXIF + thumbnails); only the object key + metadata land in Postgres.
 * Because the filesystem write can't enlist in the DB transaction, put() runs
 * BEFORE txWithAudit and the orphaned object is compensated (deleted) if the
 * audited insert fails.
 */

const STORAGE_CATEGORY: Record<AttachmentCategory, StorageCategory> = {
  ROOM: "room",
  CONTROL_PANEL: "control_panel",
  CONNECTION_PANEL: "connection_panel",
  EQUIPMENT: "equipment",
  TICKET: "ticket",
};

export interface UploadFile {
  body: Buffer;
  contentType: string;
  filename: string;
}

export async function createAttachment(
  actor: AuditActor,
  file: UploadFile,
  input: AttachmentUploadInput,
): Promise<Attachment> {
  const stored = await getStorage().put({
    body: file.body,
    contentType: file.contentType,
    category: STORAGE_CATEGORY[input.category],
    filename: file.filename,
  });
  try {
    return await txWithAudit(actor, async (tx, audit) => {
      const attachment = await tx.attachment.create({
        data: {
          objectKey: stored.objectKey,
          category: input.category,
          filename: file.filename,
          contentType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          width: stored.width ?? null,
          height: stored.height ?? null,
          roomId: input.roomId ?? null,
          equipmentId: input.equipmentId ?? null,
          ticketId: input.ticketId ?? null,
          createdById: actor.id ?? null,
        },
      });
      await audit({
        action: "AttachmentAdded",
        entityType: "attachment",
        entityId: attachment.id,
        data: { category: attachment.category, filename: attachment.filename },
      });
      return attachment;
    });
  } catch (e) {
    // The DB row never landed — don't leak the stored object.
    await getStorage()
      .delete(stored.objectKey)
      .catch(() => {});
    throw e;
  }
}

export async function deleteAttachment(actor: AuditActor, id: string): Promise<Attachment> {
  // Delete-and-audit in one tx; no separate existence pre-check (that races a
  // concurrent delete). Prisma P2025 (already gone) → a clean NotFound.
  let attachment: Attachment;
  try {
    attachment = await txWithAudit(actor, async (tx, audit) => {
      const deleted = await tx.attachment.delete({ where: { id } });
      await audit({
        action: "AttachmentRemoved",
        entityType: "attachment",
        entityId: id,
        data: { filename: deleted.filename },
      });
      return deleted;
    });
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "P2025") {
      throw new NotFoundError(tr("places.err.attachment.notFound"));
    }
    throw e;
  }
  // Row is gone (audited); drop the bytes best-effort (orphaned bytes are harmless).
  await getStorage()
    .delete(attachment.objectKey)
    .catch(() => {});
  return attachment;
}

import { db } from "~/lib/db.server";
import { tr } from "~/i18n/request-locale.server";
import { getStorage } from "~/lib/storage/storage.server";
import type { AttachmentCategory } from "~/generated/prisma/client";

/** Read-only queries for attachments (only the object key + metadata; never bytes). */

export interface AttachmentRow {
  id: string;
  objectKey: string;
  category: AttachmentCategory;
  filename: string;
  contentType: string;
  width: number | null;
  height: number | null;
  createdAt: Date;
}

export async function listAttachments(
  where: {
    roomId?: string;
    equipmentId?: string;
    ticketId?: string;
  },
  page: { offset?: number; limit?: number } = {},
): Promise<AttachmentRow[]> {
  if (!where.roomId && !where.equipmentId && !where.ticketId) return [];
  return db.attachment.findMany({
    skip: page.offset,
    take: page.limit,
    where: { roomId: where.roomId, equipmentId: where.equipmentId, ticketId: where.ticketId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      objectKey: true,
      category: true,
      filename: true,
      contentType: true,
      width: true,
      height: true,
      createdAt: true,
    },
  });
}

/** Lookup used by the serve route to authorize + content-type a raw object fetch. */
export function getAttachmentByKey(objectKey: string) {
  return db.attachment.findUnique({
    where: { objectKey },
    select: { id: true, contentType: true, filename: true },
  });
}

export function getAttachmentMetadata(id: string) {
  return db.attachment.findUnique({
    where: { id },
    select: {
      id: true,
      category: true,
      filename: true,
      contentType: true,
      sizeBytes: true,
      width: true,
      height: true,
      createdAt: true,
      room: { select: { id: true, name: true } },
      equipment: { select: { id: true, name: true, assetTag: true } },
      ticket: { select: { id: true, title: true } },
    },
  });
}

/**
 * Display label per provider class — the `StorageProvider` interface is frozen.
 * Resolved at call time (never at import) so the dashboard renders the request locale.
 */
function storageBackendLabel(backendName: string): string {
  if (backendName === "FsStorageProvider") return tr("places.err.storage.backendFs");
  if (backendName === "NotImplementedStorageProvider")
    return tr("places.err.storage.backendUnconfigured");
  return backendName;
}

/**
 * Dashboard „Speicher & Index": attachment count + bytes held, plus
 * which storage backend is installed. Attachment is hard-delete (Restrict on
 * every parent — an orphaned row would strand its encrypted blob), so every
 * row counts.
 */
export async function getStorageStats() {
  const aggregate = await db.attachment.aggregate({
    _count: { _all: true },
    _sum: { sizeBytes: true },
  });
  const backendName = getStorage().constructor.name;
  return {
    attachmentCount: aggregate._count._all,
    totalBytes: aggregate._sum.sizeBytes ?? 0,
    backend: storageBackendLabel(backendName),
  };
}

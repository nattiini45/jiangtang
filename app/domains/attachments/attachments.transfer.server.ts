import { z } from "zod";
import { msgKey } from "~/i18n";
import { tr } from "~/i18n/request-locale.server";
import type { AuditActor } from "~/lib/audit.server";
import { NotFoundError } from "~/lib/errors.server";
import { getRoom } from "~/domains/rooms/rooms.queries.server";
import { getEquipment } from "~/domains/inventory/inventory.queries.server";
import { getTicket } from "~/domains/tickets/tickets.queries.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { MAX_UPLOAD_BYTES, sniffImageType } from "~/lib/storage/image.server";
import { attachmentUploadSchema } from "./attachments.schema";
import { createAttachment, deleteAttachment } from "./attachments.mutations.server";
import { fetchAttachmentUrl } from "./attachment-url.server";
import type { Attachment } from "~/generated/prisma/client";

export const ATTACHMENT_UPLOAD_CONCURRENCY = 2;
export const ATTACHMENT_UPLOAD_LIMIT = 10;
export const ATTACHMENT_UPLOAD_WINDOW_MS = 60_000;

let activeUploads = 0;
const uploadBuckets = new Map<string, { count: number; expiresAt: number }>();

export const attachmentTransferSchema = attachmentUploadSchema
  .safeExtend({
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (name) =>
          !/[\p{Cc}/\\\u202a-\u202e\u2066-\u2069]/u.test(name) && name !== "." && name !== "..",
      ),
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    base64: z
      .string()
      .min(1)
      .max(4 * Math.ceil(MAX_UPLOAD_BYTES / 3))
      .optional(),
    url: z.string().min(1).max(4096).optional(),
  })
  .refine((input) => (input.base64 !== undefined) !== (input.url !== undefined), {
    message: msgKey("err.mcp.attachmentSource"),
    path: ["base64"],
  });

export function decodeAttachmentBase64(value: string): Buffer {
  if (value.length > 4 * Math.ceil(MAX_UPLOAD_BYTES / 3)) {
    throw new Response(tr("err.mcp.attachmentTooLarge"), { status: 413 });
  }
  if (!value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Response(tr("err.mcp.attachmentBase64"), { status: 422 });
  }
  const body = Buffer.from(value, "base64");
  if (body.toString("base64") !== value) {
    throw new Response(tr("err.mcp.attachmentBase64"), { status: 422 });
  }
  if (!body.length || body.length > MAX_UPLOAD_BYTES) {
    throw new Response(tr("err.mcp.attachmentTooLarge"), { status: 413 });
  }
  return body;
}

function metadata(attachment: Attachment) {
  return {
    id: attachment.id,
    category: attachment.category,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    width: attachment.width,
    height: attachment.height,
    roomId: attachment.roomId,
    equipmentId: attachment.equipmentId,
    ticketId: attachment.ticketId,
    createdAt: attachment.createdAt,
  };
}

async function notify(attachment: Attachment, op: "created" | "deleted") {
  await emitChange({ entityType: "attachment", id: attachment.id, op });
  if (attachment.roomId)
    await emitChange({ entityType: "room", id: attachment.roomId, op: "updated" });
  if (attachment.equipmentId)
    await emitChange({ entityType: "equipment", id: attachment.equipmentId, op: "updated" });
  if (attachment.ticketId)
    await emitChange({ entityType: "ticket", id: attachment.ticketId, op: "updated" });
}

export async function uploadAttachmentTransfer(actor: AuditActor, value: unknown) {
  const input = attachmentTransferSchema.parse(value);
  if (activeUploads >= ATTACHMENT_UPLOAD_CONCURRENCY) {
    throw new Response(tr("err.mcp.attachmentBusy"), {
      status: 429,
      headers: { "Retry-After": "1" },
    });
  }
  const now = Date.now();
  for (const [key, bucket] of uploadBuckets) {
    if (bucket.expiresAt <= now) uploadBuckets.delete(key);
  }
  const key = actor.via ? `token:${actor.via.tokenId}` : `user:${actor.id ?? "anonymous"}`;
  const bucket = uploadBuckets.get(key) ?? {
    count: 0,
    expiresAt: now + ATTACHMENT_UPLOAD_WINDOW_MS,
  };
  if (bucket.count >= ATTACHMENT_UPLOAD_LIMIT) {
    throw new Response(tr("err.mcp.attachmentRateLimit"), {
      status: 429,
      headers: { "Retry-After": String(Math.ceil((bucket.expiresAt - now) / 1000)) },
    });
  }
  bucket.count++;
  uploadBuckets.set(key, bucket);
  activeUploads++;
  try {
    const target = input.roomId
      ? await getRoom(input.roomId)
      : input.equipmentId
        ? await getEquipment(input.equipmentId)
        : await getTicket(input.ticketId!);
    if (!target) throw new NotFoundError();
    const file =
      input.url !== undefined
        ? await fetchAttachmentUrl(input.url)
        : { body: decodeAttachmentBase64(input.base64!), contentType: input.contentType };
    if (file.contentType !== input.contentType || sniffImageType(file.body) !== input.contentType) {
      throw new Response(tr("err.mcp.attachmentTypeMismatch"), { status: 422 });
    }
    const attachment = await createAttachment(actor, { ...file, filename: input.filename }, input);
    await notify(attachment, "created");
    return metadata(attachment);
  } finally {
    activeUploads--;
  }
}

export async function deleteAttachmentTransfer(actor: AuditActor, id: string) {
  const attachment = await deleteAttachment(actor, id);
  await notify(attachment, "deleted");
  return metadata(attachment);
}

import { z } from "zod";
import { msgKey } from "~/i18n";
import { AttachmentCategory } from "~/generated/prisma/enums";

/** Metadata for an upload (the File itself is handled in the route action). */

const optionalId = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

export const attachmentUploadSchema = z
  .object({
    category: z.enum(AttachmentCategory),
    roomId: optionalId,
    equipmentId: optionalId,
    ticketId: optionalId,
  })
  .refine((a) => [a.roomId, a.equipmentId, a.ticketId].filter(Boolean).length === 1, {
    message: msgKey("places.err.attachment.targetRequired"),
    path: ["category"],
  });

export type AttachmentUploadInput = z.infer<typeof attachmentUploadSchema>;

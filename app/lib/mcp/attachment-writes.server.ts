import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  attachmentTransferSchema,
  uploadAttachmentTransfer,
  deleteAttachmentTransfer,
} from "~/domains/attachments/attachments.transfer.server";
import { registerTool } from "./tools.server";
import { mcpActor, type McpContext } from "./types.server";

export function registerAttachmentWrites(server: McpServer, context: McpContext): void {
  registerTool(
    server,
    context,
    {
      name: "upload_attachment",
      description:
        "Upload a JPEG, PNG or WebP image (15 MB maximum) to exactly one room, equipment item or ticket. " +
        "Provide exactly one canonical base64 payload or public HTTPS URL, plus filename and contentType. " +
        "URLs cannot redirect. Images are validated, stripped of EXIF/GPS metadata and encrypted at rest.",
      schema: attachmentTransferSchema,
      write: true,
      openWorld: true,
    },
    (input, ctx) => uploadAttachmentTransfer(mcpActor(ctx), input),
  );
  registerTool(
    server,
    context,
    {
      name: "delete_attachment",
      description: "Permanently delete an attachment and its stored image. Requires confirm: true.",
      schema: z.object({ id: z.string().min(1).max(200), confirm: z.literal(true) }),
      write: true,
      destructive: true,
    },
    (input, ctx) => deleteAttachmentTransfer(mcpActor(ctx), input.id),
  );
}

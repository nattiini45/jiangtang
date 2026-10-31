import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser, sanitizeNext } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { MAX_UPLOAD_BYTES, UnsupportedImageError } from "~/lib/storage/image.server";
import { attachmentUploadSchema } from "~/domains/attachments/attachments.schema";
import {
  createAttachment,
  deleteAttachment,
} from "~/domains/attachments/attachments.mutations.server";

/**
 * Resource route (action only) for attachment upload + delete. Both redirect back
 * to a `redirectTo` (validated through sanitizeNext — local paths only). A rejected
 * upload redirects with ?uploadError= so the FileUpload component can surface it
 * inline instead of dumping a raw error page.
 */

function withError(to: string, message: string): string {
  const sep = to.includes("?") ? "&" : "?";
  return `${to}${sep}uploadError=${encodeURIComponent(message)}`;
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);

  // Reject oversized bodies BEFORE request.formData() buffers them into memory
  // (defense-in-depth; the Caddy `request_body max_size` is the primary guard).
  // +1MB margin covers multipart field/boundary overhead.
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES + 1_000_000) {
    return new Response(t(locale, "err.upload.tooLarge"), { status: 413 });
  }

  const form = await request.formData();
  const intent = String(form.get("_action") ?? "upload");
  const redirectTo = sanitizeNext(String(form.get("redirectTo") ?? "/"));

  try {
    if (intent === "delete") {
      const deleted = await deleteAttachment(actor, String(form.get("id") ?? ""));
      await emitChange({ entityType: "attachment", id: deleted.id, op: "deleted" });
      return redirect(redirectTo);
    }

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new ValidationError({ file: [t(locale, "err.upload.selectFile")] });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ValidationError({ file: [t(locale, "err.upload.tooLarge")] });
    }
    const meta = safeParse(attachmentUploadSchema, formDataToObject(form), locale);
    if (!meta.success) throw new ValidationError(meta.fieldErrors);

    const body = Buffer.from(await file.arrayBuffer());
    const attachment = await createAttachment(
      actor,
      {
        body,
        contentType: file.type || "application/octet-stream",
        filename: file.name || "upload",
      },
      meta.data,
    );
    await emitChange({ entityType: "attachment", id: attachment.id, op: "created" });
    return redirect(redirectTo);
  } catch (e) {
    // Surface user-correctable problems inline on the originating page.
    if (e instanceof ValidationError) {
      const first = Object.values(e.fieldErrors)[0]?.[0] ?? t(locale, "err.upload.failed");
      return redirect(withError(redirectTo, first));
    }
    if (e instanceof UnsupportedImageError) {
      return redirect(withError(redirectTo, e.message));
    }
    // A bad/stale target id (FK violation) → inline message, not a raw 500.
    if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "P2003") {
      return redirect(withError(redirectTo, t(locale, "err.upload.targetNotFound")));
    }
    throw toErrorResponse(e);
  }
}

import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { getStorage } from "~/lib/storage/storage.server";
import { getAttachmentByKey } from "~/domains/attachments/attachments.queries.server";

/**
 * Resource route (no component) that streams a stored object's decrypted bytes.
 * Top-level, so it is NOT under the _desktop auth layout — it guards itself with
 * requireUser. The Attachment row is looked up first, so only known keys are
 * served (no arbitrary disk reads) and the content-type is authoritative.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const key = params.key;
  const wantThumb = new URL(request.url).searchParams.has("thumb");

  const attachment = await getAttachmentByKey(key);
  if (!attachment)
    throw new Response(t(resolveLocale(request), "err.notFoundBody"), { status: 404 });

  let body: Buffer;
  try {
    ({ body } = await getStorage().get(wantThumb ? `${key}.thumb` : key));
  } catch (e) {
    // Blob missing on disk (e.g. backup/restore mismatch) → 404, not a 500.
    if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "ENOENT") {
      throw new Response(t(resolveLocale(request), "err.notFoundBody"), { status: 404 });
    }
    throw e;
  }
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": wantThumb ? "image/jpeg" : attachment.contentType,
      "Content-Length": String(body.length),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${encodeURIComponent(attachment.filename)}"`,
    },
  });
}

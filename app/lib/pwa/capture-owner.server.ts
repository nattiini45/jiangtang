import { CAPTURE_OWNER_HEADER } from "~/lib/pwa/offline-queue";

/**
 * Refuse a capture that was queued by someone other than the signed-in user.
 *
 * Browser tabs share one cookie jar, so a tab that still shows the previous
 * user can replay their queued captures after another tab signed in as someone
 * else; the session cookie alone would create those rows, and audit them, under
 * the new user. The queue sends its owner with every capture POST, and the
 * answer is a 403, which the queue reads as the sign-in wall and keeps the entry.
 *
 * A request without the header (a plain form post) is not checked. Call this
 * before any write.
 */
export function assertCaptureOwner(request: Request, actor: { id?: string | null }): void {
  const owner = request.headers.get(CAPTURE_OWNER_HEADER);
  if (owner !== null && owner !== actor.id) {
    throw new Response("Forbidden", { status: 403 });
  }
}

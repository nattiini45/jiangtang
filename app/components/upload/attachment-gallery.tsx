import { Form } from "react-router";
import { Button } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";
import type { AttachmentRow } from "~/domains/attachments/attachments.queries.server";

/**
 * Thumbnail grid for an entity's attachments. Thumbnails are served from the
 * auth-guarded /attachments/:key?thumb route; clicking opens the full image.
 * Delete posts to the /attachments/upload resource route.
 */
export function AttachmentGallery({
  attachments,
  redirectTo,
}: {
  attachments: AttachmentRow[];
  redirectTo: string;
}) {
  const t = useT();
  if (attachments.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("upload.gallery.empty")}</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {attachments.map((a) => (
        <figure key={a.id} className="border-border group relative overflow-hidden border">
          <a href={`/attachments/${a.objectKey}`} target="_blank" rel="noreferrer">
            <img
              src={`/attachments/${a.objectKey}?thumb=1`}
              alt={a.filename}
              loading="lazy"
              className="aspect-square w-full bg-muted object-cover"
            />
          </a>
          <Form
            method="post"
            action="/attachments/upload"
            className="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100"
            onSubmit={(e) => {
              if (!confirm(t("upload.gallery.confirmDelete"))) e.preventDefault();
            }}
          >
            <input type="hidden" name="_action" value="delete" />
            <input type="hidden" name="id" value={a.id} />
            <input type="hidden" name="redirectTo" value={redirectTo} />
            <Button
              type="submit"
              variant="destructive"
              size="icon"
              className="size-6"
              title={t("upload.gallery.delete")}
            >
              ✕
            </Button>
          </Form>
        </figure>
      ))}
    </div>
  );
}

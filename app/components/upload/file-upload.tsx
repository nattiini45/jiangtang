import { Form, useNavigation, useSearchParams } from "react-router";
import { AttachmentCategory } from "~/generated/prisma/enums";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { useT } from "~/i18n/use-t";

/**
 * Multipart upload form (reused by rooms / equipment / tickets). Posts to the
 * /attachments/upload resource route, which redirects back to `redirectTo`
 * (appending ?uploadError= on a rejected upload, surfaced here).
 */

export function FileUpload({
  target,
  categories,
  redirectTo,
}: {
  target: { roomId?: string; equipmentId?: string; ticketId?: string };
  categories: AttachmentCategory[];
  redirectTo: string;
}) {
  const t = useT();
  const nav = useNavigation();
  const [params] = useSearchParams();
  const uploadError = params.get("uploadError");
  const busy = nav.state !== "idle";

  return (
    <div className="flex flex-col gap-1.5">
      <Form
        method="post"
        action="/attachments/upload"
        encType="multipart/form-data"
        className="flex flex-wrap items-center gap-2"
      >
        {target.roomId ? <input type="hidden" name="roomId" value={target.roomId} /> : null}
        {target.equipmentId ? (
          <input type="hidden" name="equipmentId" value={target.equipmentId} />
        ) : null}
        {target.ticketId ? <input type="hidden" name="ticketId" value={target.ticketId} /> : null}
        <input type="hidden" name="redirectTo" value={redirectTo} />
        <input
          type="file"
          name="file"
          accept="image/jpeg,image/png,image/webp"
          required
          className="max-w-[16rem] text-sm file:mr-2 file:cursor-pointer file:rounded-md file:bg-tint file:px-3 file:py-1 file:text-xs file:font-semibold hover:file:bg-tint-hover"
        />
        {categories.length > 1 ? (
          <Select name="category" defaultValue={categories[0]} className="max-w-[12rem]">
            {categories.map((c) => (
              <option key={c} value={c}>
                {t(`upload.category.${c}`)}
              </option>
            ))}
          </Select>
        ) : (
          <input type="hidden" name="category" value={categories[0]} />
        )}
        <Button type="submit" size="compact" disabled={busy}>
          {busy ? t("upload.busy") : t("upload.submit")}
        </Button>
      </Form>
      {uploadError ? (
        <p className="text-destructive text-xs" role="alert">
          {uploadError}
        </p>
      ) : null}
    </div>
  );
}

import { useState } from "react";
import { useFetcher } from "react-router";
import { Button } from "@ui-sdk/react/button";
import { RoomTypeSelect } from "./room-expectations-fields";
import { buttonVariants } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";
import type { listRoomTypes } from "~/domains/rooms/room-types.queries.server";

export function RoomTypeBulk({
  ids,
  types,
}: {
  ids: string[];
  types: Awaited<ReturnType<typeof listRoomTypes>>;
}) {
  const t = useT();
  const fetcher = useFetcher<{ saved?: boolean; error?: string }>();
  const [type, setType] = useState<string | null>(null);
  return (
    <fetcher.Form
      method="post"
      action="/rooms?index"
      aria-label={t("functions.types.bulk")}
      className="bg-card shadow-surface-2 flex min-w-0 flex-wrap items-end gap-3 rounded-lg p-3"
    >
      <input type="hidden" name="_action" value="setRoomType" />
      {ids.map((id) => (
        <input key={id} type="hidden" name="roomIds" value={id} />
      ))}
      <div className="min-w-0 flex-1">
        <RoomTypeSelect types={types} value={type} onValueChange={setType} />
      </div>
      <p className="py-2 text-sm nums">{t("functions.types.selected", { count: ids.length })}</p>
      <Button
        type="submit"
        className={buttonVariants()}
        disabled={!ids.length || fetcher.state !== "idle"}
      >
        {t("functions.types.bulk")}
      </Button>
      {fetcher.data?.error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {fetcher.data.error}
        </p>
      ) : fetcher.data?.saved ? (
        <p role="status" className="w-full text-sm">
          {t("functions.types.saved")}
        </p>
      ) : null}
    </fetcher.Form>
  );
}

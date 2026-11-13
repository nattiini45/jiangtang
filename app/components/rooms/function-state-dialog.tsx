import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@ui-sdk/react/dialog";
import { Input } from "@ui-sdk/react/input";
import { Textarea } from "@ui-sdk/react/textarea";
import { Button } from "@ui-sdk/react/button";
import { useT } from "~/i18n/use-t";
import { buttonVariants } from "~/components/ui/button";
import { fieldClassName } from "~/components/ui/input";
import { Select } from "~/components/ui/select";

export function FunctionStateDialog({
  roomId,
  functionId,
}: {
  roomId: string;
  functionId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={`${buttonVariants({ variant: "tertiary" })} min-h-11 self-start`}>
        {t("functions.override.title")}
      </DialogTrigger>
      <DialogContent className="bg-card text-foreground shadow-surface-5 fixed inset-0 m-auto h-fit max-h-[90dvh] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto rounded-lg p-5 backdrop:bg-scrim">
        <DialogTitle className="text-base font-semibold">
          {t("functions.override.title")}
        </DialogTitle>
        <DialogDescription className="my-3 text-sm text-muted-foreground">
          {t("functions.override.help")}
        </DialogDescription>
        <fetcher.Form method="post" action="/functions/state" className="flex flex-col gap-3">
          <input type="hidden" name="roomId" value={roomId} />
          <input type="hidden" name="functionId" value={functionId} />
          <label className="flex flex-col gap-1 text-sm">
            {t("functions.list.state")}
            <Select name="state" defaultValue="WORKS">
              {(["WORKS", "LIMITED", "DOWN"] as const).map((state) => (
                <option key={state} value={state}>
                  {t(`functions.state.${state}`)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("functions.override.reason")}
            <Textarea
              name="reason"
              required
              maxLength={5000}
              rows={2}
              className={`${fieldClassName} p-3`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("functions.override.until")}
            <Input
              name="until"
              type="datetime-local"
              className={`${fieldClassName} min-h-11 px-3`}
            />
          </label>
          {fetcher.data?.error ? (
            <p role="alert" className="text-sm text-destructive">
              {fetcher.data.error}
            </p>
          ) : null}
          <Button
            type="submit"
            name="intent"
            value="set"
            disabled={fetcher.state !== "idle"}
            className={`${buttonVariants()} min-h-11`}
          >
            {t("common.save")}
          </Button>
          <Button
            type="submit"
            name="intent"
            value="clear"
            formNoValidate
            disabled={fetcher.state !== "idle"}
            className={`${buttonVariants({ variant: "secondary" })} min-h-11`}
          >
            {t("functions.override.clear")}
          </Button>
          <DialogClose className={`${buttonVariants({ variant: "tertiary" })} min-h-11`}>
            {t("common.cancel")}
          </DialogClose>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

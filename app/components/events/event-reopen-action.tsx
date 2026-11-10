import { useId } from "react";
import { Form, useNavigation } from "react-router";
import { Button } from "~/components/ui/button";
import { eventAllowedActions } from "~/domains/events/events.actions";
import type { EventStatus } from "~/generated/prisma/client";
import { useT } from "~/i18n/use-t";

export function EventReopenAction({ status }: { status: EventStatus }) {
  const t = useT();
  const hintId = useId();
  const navigation = useNavigation();
  const action = eventAllowedActions(status)[0];
  if (!action) return null;
  return (
    <Form method="post" className="flex flex-col items-start gap-3">
      <input type="hidden" name="_action" value={action.intent} />
      <p id={hintId} className="text-muted-foreground max-w-prose text-sm">
        {t(action.hintKey)}
      </p>
      <Button
        type="submit"
        variant="secondary"
        className="min-h-11"
        aria-describedby={hintId}
        disabled={navigation.state !== "idle"}
      >
        {t(action.labelKey)}
      </Button>
    </Form>
  );
}

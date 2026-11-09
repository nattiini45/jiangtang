import { useId, useState } from "react";
import { Form, useNavigation } from "react-router";
import type { MessageKey } from "~/i18n";
import { useT } from "~/i18n/use-t";
import type { TransitionAction } from "~/lib/transitions";
import { Button, type ButtonProps } from "~/components/ui/button";
import { Select } from "~/components/ui/select";

export function StatusTransitionForm({
  currentState,
  currentLabel,
  allowedActions,
  reasonKey,
  selectLabel,
  submitLabel,
  variant,
  selectClassName,
}: {
  currentState: string;
  currentLabel: string;
  allowedActions: TransitionAction[];
  reasonKey: MessageKey;
  selectLabel: string;
  submitLabel: string;
  variant: ButtonProps["variant"];
  selectClassName: string;
}) {
  const t = useT();
  const navigation = useNavigation();
  const [target, setTarget] = useState(currentState);
  const reasonId = useId();
  const canSubmit = allowedActions.some((action) => action.target === target && action.allowed);
  return (
    <Form method="post" className="flex items-center gap-2">
      <input type="hidden" name="_action" value="status" />
      <Select
        name="status"
        value={target}
        onChange={(event) => setTarget(event.target.value)}
        aria-label={selectLabel}
        className={selectClassName}
      >
        <option value={currentState} disabled title={t(reasonKey)}>
          {currentLabel}
        </option>
        {allowedActions.map((action) => (
          <option key={action.target} value={action.target} disabled={!action.allowed}>
            {t(action.labelKey)}
          </option>
        ))}
      </Select>
      <span title={!canSubmit ? t(reasonKey) : undefined}>
        <Button
          type="submit"
          variant={variant}
          size="compact"
          disabled={navigation.state !== "idle" || !canSubmit}
          aria-describedby={!canSubmit ? reasonId : undefined}
        >
          {submitLabel}
        </Button>
      </span>
      {!canSubmit ? (
        <span id={reasonId} className="sr-only">
          {t(reasonKey)}
        </span>
      ) : null}
    </Form>
  );
}

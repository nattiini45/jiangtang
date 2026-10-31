import * as React from "react";
import { Form } from "react-router";
import { cn } from "~/lib/utils";
import { Label } from "~/components/ui/label";

/**
 * Form helpers for the app's validation conventions. The server action calls
 * `safeParseForm(request, schema)` and returns `{ fieldErrors }` (or throws
 * ValidationError → 422); pass `fieldErrors={actionData?.fieldErrors}` to ZodForm
 * and wrap inputs in <FormField name=…> to surface per-field messages.
 */

export type FieldErrors = Record<string, string[] | undefined>;

const FieldErrorContext = React.createContext<FieldErrors>({});

export function ZodForm({
  fieldErrors,
  className,
  method = "post",
  children,
  ...props
}: React.ComponentProps<typeof Form> & { fieldErrors?: FieldErrors }) {
  return (
    <FieldErrorContext.Provider value={fieldErrors ?? {}}>
      <Form method={method} className={cn("flex flex-col gap-4", className)} {...props}>
        {children}
      </Form>
    </FieldErrorContext.Provider>
  );
}

export function useFieldError(name: string): string | undefined {
  return React.useContext(FieldErrorContext)[name]?.[0];
}

export function FormField({
  name,
  label,
  hint,
  className,
  children,
}: {
  name: string;
  label?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const error = useFieldError(name);
  // Derive the control id ONCE so the Label's htmlFor always matches the id the
  // control actually renders with — if a caller passes a child with an explicit
  // id that differs from `name`, htmlFor={name} would break the a11y association.
  const controlId = React.isValidElement(children)
    ? ((children as React.ReactElement<{ id?: string }>).props.id ?? name)
    : name;
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id: controlId })
    : children;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? <Label htmlFor={controlId}>{label}</Label> : null}
      {control}
      {hint && !error ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

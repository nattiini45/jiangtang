/**
 * Notes form-level errors — the `task-form-errors` shape one feature
 * over: a refusal's `formErrors` render as an alert banner, not a 422 page.
 */
export function NoteFormErrors({ formErrors }: { formErrors?: string[] }) {
  if (!formErrors?.length) return null;
  return (
    <div role="alert" className="bg-destructive/15 text-foreground rounded-md px-3 py-2 text-sm">
      {formErrors.map((e, i) => (
        <p key={i}>{e}</p>
      ))}
    </div>
  );
}

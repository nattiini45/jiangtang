/**
 * The form-level error list.
 *
 * `ValidationError` carries two channels: `fieldErrors`, which `FormField`
 * renders under its own control, and **`formErrors`** — the channel a refusal
 * that belongs to no single field writes to. `deleteLocation`'s child-count
 * refusal is exactly that: it is not "the parentId field is wrong", it is
 * "this delete cannot happen, and here is how many children are in the way".
 * Dropping `formErrors` on the floor would render that refusal as *no message
 * at all* next to a form that silently did nothing.
 *
 * `role="alert"` because it is the answer to a submit, and a screen-reader user
 * who just pressed a button needs it announced.
 */
export function LocationFormErrors({ formErrors }: { formErrors?: string[] }) {
  if (!formErrors || formErrors.length === 0) return null;
  return (
    <div
      role="alert"
      className="border-destructive text-destructive rounded-sm border px-3 py-2 text-sm"
    >
      <ul className="flex flex-col gap-1">
        {formErrors.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

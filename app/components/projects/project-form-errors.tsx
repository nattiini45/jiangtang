/**
 * The form-level error list — the `formErrors` channel a refusal that belongs
 * to no single field writes to (`deleteProject`'s sub-project refusal, the
 * reparent-into-own-subtree refusal). Same contract as `LocationFormErrors`.
 */
export function ProjectFormErrors({ formErrors }: { formErrors?: string[] }) {
  if (!formErrors || formErrors.length === 0) return null;
  return (
    <div
      role="alert"
      className="text-destructive bg-card shadow-surface-2 rounded-lg px-3 py-2 text-sm"
    >
      <ul className="flex flex-col gap-1">
        {formErrors.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

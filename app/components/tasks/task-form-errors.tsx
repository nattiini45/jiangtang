/**
 * The form-level error list for the task forms — the `formErrors` channel a
 * refusal that belongs to no single field writes to (delete-with-subtasks,
 * cycle refusals, stale-lane moves). Same contract as `ProjectFormErrors`.
 */
export function TaskFormErrors({ formErrors }: { formErrors?: string[] }) {
  if (!formErrors || formErrors.length === 0) return null;
  return (
    <div role="alert" className="bg-destructive/10 text-foreground rounded-lg px-3 py-2 text-sm">
      <ul className="flex flex-col gap-1">
        {formErrors.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

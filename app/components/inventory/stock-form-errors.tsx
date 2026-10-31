/**
 * The form-level error list for the stock forms — the `locations` precedent, by way of a
 * component of its own rather than an import of `LocationFormErrors`.
 *
 * ⚠️ **Why this is not a shared primitive.** `LocationFormErrors` is a three-line
 * `<ul role="alert">` in `app/components/locations/`, and this is the same three lines in
 * `app/components/inventory/`. Reusing it would put a *locations* component inside a
 * *stock* form, and the grant this slice works under names new files under
 * `app/components/inventory/` — it does not grant edits to the locations tree or to
 * `app/components/ui/`, and a track that reaches past its grant to avoid three duplicated
 * lines has bought a coupling and lost a boundary. If a third copy appears, the right move
 * is a decision about a shared primitive, taken once, in its own row.
 *
 * The reason it exists at all: `ValidationError` has **two** channels. `fieldErrors` render
 * under their own control; `formErrors` is the channel a refusal belonging to no single
 * field writes to — `deleteStockItem`'s "linked stock is not deleted" is exactly that. An
 * action that returns only `fieldErrors` renders that refusal as **no message at all** next
 * to a form that silently did nothing, which is how a refused delete becomes a bug report.
 *
 * `role="alert"` because it is the answer to a submit, and someone who just pressed a
 * button needs it announced.
 */
export function StockFormErrors({ formErrors }: { formErrors?: string[] }) {
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

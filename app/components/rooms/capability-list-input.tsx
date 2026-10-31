import * as React from "react";
import { X } from "lucide-react";
import { Input } from "~/components/ui/input";
import { useT } from "~/i18n/use-t";

/**
 * Tag-style input for a string[] column (videoInputs / audioOutputs). Each tag is
 * rendered as a hidden <input name={name}> so the array submits through <Form> as
 * repeated keys — formDataToObject collapses them back into an array.
 */
export function CapabilityListInput({
  name,
  label,
  defaults = [],
  placeholder,
}: {
  name: string;
  label: string;
  defaults?: string[];
  placeholder?: string;
}) {
  const t = useT();
  const [items, setItems] = React.useState<string[]>(defaults);
  const [draft, setDraft] = React.useState("");

  function add() {
    const v = draft.trim();
    if (v && !items.includes(v)) setItems([...items, v]);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {items.map((it) => (
        <input key={it} type="hidden" name={name} value={it} />
      ))}
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {items.map((it, i) => (
            <span
              key={it}
              className="border-border bg-secondary inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 font-mono text-xs"
            >
              {it}
              <button
                type="button"
                aria-label={t("rooms.capability.remove", { item: it })}
                onClick={() => setItems(items.filter((_, idx) => idx !== i))}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

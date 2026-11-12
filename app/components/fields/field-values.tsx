import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDate, formatNumber } from "~/i18n/format";
import { fieldGroups, type FilledField } from "~/lib/custom-fields/fields";

export function FieldValues({ fields, foldAfter }: { fields: FilledField[]; foldAfter?: number }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  if (!fields.length) return null;
  const shown = foldAfter && !expanded ? fields.slice(0, foldAfter) : fields;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-field-values>
      {fieldGroups(shown).map(({ section, fields }) => (
        <section key={section} className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold [overflow-wrap:anywhere]">
            {section || t("fields.moreDetails")}
          </h3>
          <dl className="flex flex-col gap-2 text-sm">
            {fields.map((field) => (
              <div
                key={field.id}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3"
              >
                <dt className="text-muted-foreground [overflow-wrap:anywhere]">{field.name}</dt>
                <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  <FieldValue field={field} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {foldAfter && fields.length > foldAfter ? (
        <Button
          type="button"
          variant="ghost"
          size="compact"
          className="self-start"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? t("fields.values.less")
            : t("fields.values.more", { count: fields.length - foldAfter })}
        </Button>
      ) : null}
    </div>
  );
}

export function FieldValue({ field, compact = false }: { field: FilledField; compact?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const value = field.value;
  if (compact && field.type === "MULTI_CHOICE" && Array.isArray(value)) return value.join(", ");
  if (field.type === "MULTI_CHOICE" && Array.isArray(value))
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((label) => (
          <Badge key={label} className="max-w-full whitespace-normal [overflow-wrap:anywhere]">
            {label}
          </Badge>
        ))}
      </span>
    );
  if (field.type === "BOOLEAN") return t(value ? "fields.form.yes" : "fields.form.no");
  if (field.type === "NUMBER" && typeof value === "number")
    return (
      <>
        {formatNumber(locale, value, { maximumFractionDigits: 6 })}
        {field.unit ? ` ${field.unit}` : ""}
      </>
    );
  if (field.type === "DATE" && typeof value === "string")
    return formatDate(locale, `${value}T12:00:00Z`);
  if (field.type === "LINK" && typeof value === "string" && /^https?:\/\//i.test(value))
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-4"
      >
        {value}
        <ExternalLink className="ml-1 inline size-3" aria-label={t("fields.values.newTab")} />
      </a>
    );
  return String(value);
}

import { useState } from "react";
import { Form } from "react-router";
import { ExternalLink } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDate, formatNumber } from "~/i18n/format";
import { fieldGroups, type FilledField } from "~/lib/custom-fields/fields";

export function FieldValues({
  fields,
  foldAfter,
  essentialFirst = false,
  showLegend = true,
  canClearLegacy = false,
}: {
  fields: FilledField[];
  foldAfter?: number;
  essentialFirst?: boolean;
  showLegend?: boolean;
  canClearLegacy?: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  if (!fields.length) return null;
  const essential = (field: FilledField) => field.origin === "own" || field.weight === "must";
  const ordered = essentialFirst
    ? [...fields.filter(essential), ...fields.filter((field) => !essential(field))]
    : fields;
  const first = essentialFirst ? fields.filter(essential).length : foldAfter;
  const shown = first !== undefined && !expanded ? ordered.slice(0, first) : ordered;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-field-values>
      {fieldGroups(shown).map(({ section, fields }) => (
        <section key={section} className="min-w-0">
          {showLegend || section ? (
            <h3 className="mb-2 text-sm font-semibold [overflow-wrap:anywhere]">
              {section || t("fields.moreDetails")}
            </h3>
          ) : null}
          <dl className="flex flex-col gap-2 text-sm">
            {fields.map((field) => (
              <div
                key={field.id}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3"
              >
                <dt className="text-muted-foreground [overflow-wrap:anywhere]">{field.name}</dt>
                <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  <FieldValue field={field} />
                  {field.legacyColumn ? (
                    <div className="mt-1 text-muted-foreground text-xs">
                      <p>{t("fields.legacy.retained")}</p>
                      {canClearLegacy ? (
                        <Form method="post">
                          <input type="hidden" name="column" value={field.legacyColumn} />
                          <Button
                            type="submit"
                            name="_action"
                            value="clearLegacy"
                            variant="ghost"
                            size="compact"
                          >
                            {t("fields.legacy.clear")}
                          </Button>
                        </Form>
                      ) : null}
                    </div>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {first !== undefined && fields.length > first ? (
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
            : t("fields.values.more", { count: fields.length - first })}
        </Button>
      ) : null}
    </div>
  );
}

export function FieldValue({ field, compact = false }: { field: FilledField; compact?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const value = field.value;
  if (field.type === "RANGE" && typeof value === "object" && !Array.isArray(value)) {
    const number = (n: number) =>
      formatNumber(locale, n, {
        minimumFractionDigits: field.unit === ": 1" ? 2 : 0,
        maximumFractionDigits: 6,
      });
    return (
      <>
        {value.min == null
          ? `≤ ${number(value.max!)}`
          : value.max == null
            ? `≥ ${number(value.min)}`
            : `${number(value.min)}–${number(value.max)}`}
        {field.unit ? ` ${field.unit}` : ""}
      </>
    );
  }
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

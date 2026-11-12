import type { CustomFieldScope } from "~/generated/prisma/client";
import { ValidationError } from "~/lib/errors.server";
import { getDefinitions, getRecordSchema, type FieldDefinition } from "./definitions.server";
import { validateCustomValues } from "./values.server";
import { postedValue, sameValue, valueObject, type Field } from "./fields";
import { currentLocale, tr } from "~/i18n/request-locale.server";

export function formDefinitions(definitions: FieldDefinition[]): Field[] {
  return definitions
    .filter((field) => !field.archivedAt)
    .map((field) => ({
      id: field.id,
      key: field.key,
      name: field.name,
      type: field.type,
      unit: field.unit,
      section: field.section,
      helpText: field.helpText,
      position: field.position,
      kinds: field.kinds,
      options: field.options.map((option) => ({
        id: option.id,
        label: option.label,
        archived: !!option.archivedAt,
      })),
    }));
}

export async function getFormFields(scope: CustomFieldScope) {
  return formDefinitions(await (scope === "ROOM" ? getRecordSchema(scope) : getDefinitions(scope)));
}

export function valuesFromForm(form: FormData, fields: Field[], stored: unknown = {}) {
  const values: Record<string, unknown> = Object.create(null);
  const before = valueObject(stored);
  for (const name of new Set(form.keys())) {
    if (!name.startsWith("cf.")) continue;
    const id = name.slice(3);
    const field = fields.find((field) => field.id === id);
    const entries = form.getAll(name);
    const raw = entries.length === 1 ? entries[0] : entries;
    if (field?.type === "NUMBER" && typeof raw === "string") {
      const german = currentLocale() === "de";
      const ambiguous = german ? /^[1-9]\d{0,2}\.\d{3}$/ : /^[1-9]\d{0,2},\d{3}$/;
      if (ambiguous.test(raw.trim()))
        throw new ValidationError({
          [name]: [
            tr("fields.error.ambiguousNumber", {
              thousands: raw.trim().replace(/[.,]/, ""),
              decimal: raw.trim().replace(/[.,]/, german ? "," : "."),
            }),
          ],
        });
    }
    const value =
      field && entries.every((entry) => typeof entry === "string")
        ? postedValue(field, raw as string | string[])
        : raw;
    if (!field || !sameValue(value, before[id])) values[field?.key ?? id] = value;
  }
  return values;
}

export async function parseFieldForm(
  scope: CustomFieldScope,
  form: FormData,
  stored: unknown = {},
  kindId?: string | null,
) {
  const definitions = await getDefinitions(scope);
  const values = valuesFromForm(form, formDefinitions(definitions), stored);
  try {
    validateCustomValues(definitions, values, kindId);
  } catch (error) {
    if (error instanceof ValidationError)
      throw new ValidationError(mapFieldErrors(error.fieldErrors, formDefinitions(definitions)));
    throw error;
  }
  return Object.keys(values).length ? values : undefined;
}

function mapFieldErrors(errors: Record<string, string[]>, fields: Field[]) {
  return Object.fromEntries(
    Object.entries(errors).map(([key, messages]) => [
      fields.some((field) => field.key === key)
        ? `cf.${fields.find((field) => field.key === key)!.id}`
        : key,
      messages,
    ]),
  );
}

export async function fieldFormErrors(scope: CustomFieldScope, errors: Record<string, string[]>) {
  return mapFieldErrors(errors, await getFormFields(scope));
}

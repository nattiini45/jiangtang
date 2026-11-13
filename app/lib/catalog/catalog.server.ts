import { z } from "zod";
import { modelPortsSchema } from "~/domains/inventory/inventory.ports.schema";
import { propertiesForKind } from "~/lib/equipment-kinds/properties";
import { compileCustomValues } from "~/lib/custom-fields/values.server";
import parts from "./parts.json" with { type: "json" };

export const catalogRecordSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    manufacturer: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string()),
    partNumbers: z.array(z.string()),
    kind: z.string().min(1),
    productUrl: z.url({ protocol: /^https?$/ }),
    manualUrl: z.url({ protocol: /^https?$/ }).nullable(),
    values: z.record(z.string(), z.unknown()),
    ports: modelPortsSchema,
    sources: z
      .array(z.object({ url: z.url({ protocol: /^https?$/ }), retrievedOn: z.iso.date() }))
      .min(1),
  })
  .superRefine((record, ctx) => {
    const fields = propertiesForKind(record.kind)
      .filter((property) => property.level === "MODEL")
      .map((property) => ({
        id: property.key,
        key: property.key,
        type: property.type,
        name: property.en,
        archivedAt: null,
        kinds: [],
        options: property.options.map((option, position) => ({
          id: option.key,
          fieldId: property.key,
          position,
          createdAt: new Date(0),
          systemKey: option.key,
          label: option.en,
          archivedAt: null,
        })),
      }));
    const parsed = compileCustomValues(fields).safeParse(record.values);
    if (!parsed.success)
      ctx.addIssue({ code: "custom", message: `Invalid catalog values: ${parsed.error.message}` });
    const domain = new URL(record.productUrl).hostname.replace(/^www\./, "");
    if (
      !record.sources.some(
        (source) => new URL(source.url).hostname.replace(/^www\./, "") === domain,
      )
    )
      ctx.addIssue({ code: "custom", message: "A manufacturer source is required" });
  });
export const modelCatalogSchema = z
  .object({ version: z.number().int().positive(), records: z.array(catalogRecordSchema) })
  .superRefine((file, ctx) => {
    if (new Set(file.records.map((record) => record.key)).size !== file.records.length)
      ctx.addIssue({ code: "custom", message: "Duplicate catalog key" });
  });
export type CatalogRecord = z.infer<typeof catalogRecordSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
let loaded: Promise<ModelCatalog> | undefined;
export function loadModelCatalog() {
  return (loaded ??= import("./epson.json", { with: { type: "json" } }).then(({ default: data }) =>
    modelCatalogSchema.parse({ ...data, records: [...data.records, ...parts.records] }),
  ));
}
export async function listModelCatalog({
  query = "",
  kind,
}: { query?: string; kind?: string } = {}) {
  const words = query.trim().toLowerCase().split(/\s+/);
  return (await loadModelCatalog()).records.filter(
    (record) =>
      (!kind || record.kind === kind) &&
      words.every((word) =>
        [record.manufacturer, record.name, ...record.aliases, ...record.partNumbers]
          .join(" ")
          .toLowerCase()
          .includes(word),
      ),
  );
}

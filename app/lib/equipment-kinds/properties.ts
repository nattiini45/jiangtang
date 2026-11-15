import library from "./library.json" with { type: "json" };

export type LibraryProperty = {
  store?: "VALUE" | "READING";
  key: string;
  de: string;
  en: string;
  type:
    | "TEXT"
    | "LONG_TEXT"
    | "NUMBER"
    | "BOOLEAN"
    | "CHOICE"
    | "MULTI_CHOICE"
    | "DATE"
    | "LINK"
    | "RANGE";
  unit: string | null;
  options: { key: string; de: string; en: string }[];
  level: "MODEL" | "DEVICE";
  nature: string;
  weight: "must" | "useful" | "special";
  appliesIf: { property: string; values: string[] } | null;
  help: { de: string | null; en: string | null };
  sources: string[];
};
export type PropertyLibrary = {
  partKinds?: string[];
  version: number;
  units: { key: string; de: string; en: string }[];
  kinds: { key: string; properties?: string[] }[];
  properties: LibraryProperty[];
  sharedProperties: LibraryProperty[];
};
export const propertyLibrary = library as PropertyLibrary;
export const libraryProperties = new Map(
  [...propertyLibrary.sharedProperties, ...propertyLibrary.properties].map((property) => [
    property.key,
    property,
  ]),
);
export function isLibraryProperty(field: { systemKey: string | null }) {
  return !!field.systemKey && libraryProperties.has(field.systemKey);
}
export function propertiesForKind(key: string | null, includeReadings = false) {
  return (propertyLibrary.kinds.find((kind) => kind.key === key)?.properties ?? [])
    .map((key) => libraryProperties.get(key)!)
    .filter((property) => includeReadings || property.store !== "READING");
}

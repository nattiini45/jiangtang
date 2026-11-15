import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";
import { cloneRoom } from "~/domains/rooms/rooms.mutations.server";
import { roomCloneSchema } from "~/domains/rooms/rooms.schema";
import { valuesFromForm, parseFieldForm } from "../form.server";
import { fieldGroups, type Field } from "../fields";

const types = [
  "TEXT",
  "LONG_TEXT",
  "NUMBER",
  "BOOLEAN",
  "CHOICE",
  "MULTI_CHOICE",
  "DATE",
  "LINK",
] as const;
const fields: Field[] = types.map((type, position) => ({
  id: `id_${type}`,
  key: type.toLowerCase(),
  name: type,
  type,
  position,
  section: null,
  unit: null,
  helpText: null,
  kinds: [],
  options: [],
}));
const form = (values: Record<string, string | string[]>) => {
  const result = new FormData();
  for (const [key, value] of Object.entries(values))
    for (const item of Array.isArray(value) ? value : [value]) result.append(key, item);
  return result;
};
const fieldIds: string[] = [],
  roomIds: string[] = [];
afterEach(async () => {
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds.splice(0) } } });
  await db.customField.deleteMany({ where: { id: { in: fieldIds.splice(0) } } });
});

describe("property form values", () => {
  it("parses every input type, including a decimal comma and false", () => {
    expect(
      valuesFromForm(
        form({
          "cf.id_TEXT": "Plain",
          "cf.id_LONG_TEXT": "Long\ntext",
          "cf.id_NUMBER": "12,5",
          "cf.id_BOOLEAN": "false",
          "cf.id_CHOICE": "option-id",
          "cf.id_MULTI_CHOICE": ["one", "two"],
          "cf.id_DATE": "2040-02-29",
          "cf.id_LINK": "https://example.org/guide",
        }),
        fields,
      ),
    ).toEqual({
      text: "Plain",
      long_text: "Long\ntext",
      number: 12.5,
      boolean: false,
      choice: "option-id",
      multi_choice: ["one", "two"],
      date: "2040-02-29",
      link: "https://example.org/guide",
    });
    expect(valuesFromForm(form({ "cf.id_NUMBER": "12.5" }), fields)).toEqual({ number: 12.5 });
  });

  it("clears empty inputs of every type but sends no unchanged or absent keys", () => {
    const stored = Object.fromEntries(
      fields.map((field) => [field.id, field.type === "MULTI_CHOICE" ? ["one"] : "old"]),
    );
    expect(
      valuesFromForm(
        form(Object.fromEntries(fields.map((field) => [`cf.${field.id}`, ""]))),
        fields,
        stored,
      ),
    ).toEqual(Object.fromEntries(fields.map((field) => [field.key, null])));
    expect(
      valuesFromForm(
        form({
          "cf.id_NUMBER": "12,500",
          "cf.id_BOOLEAN": "false",
          "cf.id_MULTI_CHOICE": ["two", "one"],
        }),
        fields,
        {
          id_NUMBER: 12.5,
          id_BOOLEAN: false,
          id_MULTI_CHOICE: ["one", "two"],
          id_TEXT: "untouched",
        },
      ),
    ).toEqual({});
    expect(
      valuesFromForm(form({ "cf.id_TEXT": "changed" }), fields, {
        id_TEXT: "before",
        id_CHOICE: "archived",
      }),
    ).toEqual({ text: "changed" });
    expect(valuesFromForm(form({ "cf.id_MULTI_CHOICE": "one" }), fields)).toEqual({
      multi_choice: ["one"],
    });
    expect(valuesFromForm(form({ "cf.id_NUMBER": "not a number" }), fields).number).toBeNaN();
  });

  it("groups by the first field and keeps field position order", () => {
    expect(
      fieldGroups([
        { section: "B", position: 3 },
        { section: "A", position: 1 },
        { section: "B", position: 2 },
        { section: null, position: 0 },
      ]).map((group) => [group.section, group.fields.map((field) => field.position)]),
    ).toEqual([
      ["", [0]],
      ["A", [1]],
      ["B", [2, 3]],
    ]);
  });

  it("normalizes multipart line endings before comparing and validating long text", () => {
    expect(valuesFromForm(form({ "cf.id_LONG_TEXT": "First\r\nSecond" }), fields)).toEqual({
      long_text: "First\nSecond",
    });
    expect(
      valuesFromForm(form({ "cf.id_LONG_TEXT": "First\r\nSecond" }), fields, {
        id_LONG_TEXT: "First\nSecond",
      }),
    ).toEqual({});
  });

  it("uses the shared validation with localized errors at the form control", async () => {
    const key = `f_${randomUUID().replaceAll("-", "")}`;
    const field = await db.customField.create({
      data: { scope: "ROOM", key, name: key, type: "NUMBER" },
    });
    fieldIds.push(field.id);
    for (const locale of ["de", "en"] as const)
      await expect(
        runWithLocale(locale, () =>
          parseFieldForm("ROOM", form({ [`cf.${field.id}`]: "invalid" })),
        ),
      ).rejects.toMatchObject({
        fieldErrors: { [`cf.${field.id}`]: [t(locale, "fields.error.number")] },
      });
    expect(await parseFieldForm("ROOM", form({ [`cf.${field.id}`]: "1,25" }))).toEqual({
      [key]: 1.25,
    });
  });

  it("copies all stored room and device values, including hidden and archived selections", async () => {
    const values = { hidden: "retained", archived: ["old-option"], no: false };
    const source = await db.room.create({
      data: { name: randomUUID(), slug: randomUUID(), customValues: values },
    });
    roomIds.push(source.id);
    await db.equipment.create({
      data: { roomId: source.id, category: "PROJECTOR", customValues: values },
    });
    const copy = await cloneRoom(
      { name: "Synthetic editor" },
      source.slug,
      roomCloneSchema.parse({ name: randomUUID(), copyEquipment: true }),
    );
    roomIds.push(copy.id);
    expect(copy.customValues).toEqual(values);
    expect(
      (await db.equipment.findFirstOrThrow({ where: { roomId: copy.id } })).customValues,
    ).toEqual(values);
  });
});

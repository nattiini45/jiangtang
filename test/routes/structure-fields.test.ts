import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";
import { action } from "~/routes/_desktop.admin.structure/route";

const access = vi.hoisted(() => ({ role: "ADMIN" }));
vi.mock("~/lib/auth.server", () => ({
  requireRole: vi.fn(async (_request: Request, role: string) => {
    if (role !== access.role) throw new Response(null, { status: 403 });
    return { name: "Synthetic administrator" };
  }),
}));
const ids: string[] = [];
afterEach(async () => {
  access.role = "ADMIN";
  await db.customField.deleteMany({ where: { id: { in: ids.splice(0) } } });
});
function args(payload: unknown, origin = "http://localhost", locale = "de") {
  return {
    request: new Request("http://localhost/admin/structure", {
      method: "POST",
      headers: { origin, "accept-language": locale },
      body: new URLSearchParams({
        intent: "field",
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      }),
    }),
  } as never;
}

describe("Structure field actions", () => {
  it("refuses member writes and cross-origin writes before parsing", async () => {
    access.role = "MEMBER";
    await expect(action(args("invalid"))).rejects.toMatchObject({ status: 403 });
    access.role = "ADMIN";
    await expect(action(args("invalid", "https://example.test"))).rejects.toMatchObject({
      status: 403,
    });
  });

  it.each(["de", "en"] as const)(
    "localizes malformed and whitespace-only payloads in %s",
    async (locale) => {
      const malformed = await runWithLocale(locale, () =>
        action(args("not-json", undefined, locale)),
      );
      expect(malformed).toMatchObject({ init: { status: 422 } });
      const invalid = await runWithLocale(locale, () =>
        action(
          args(
            { op: "create", input: { scope: "ROOM", type: "TEXT", name: "   " } },
            undefined,
            locale,
          ),
        ),
      );
      expect(invalid).toMatchObject({
        init: { status: 422 },
        data: { fieldErrors: { name: [t(locale, "fields.admin.labelInvalid")] } },
      });
    },
  );

  it("maps duplicate-option failures to localized recoverable text", async () => {
    const field = await db.customField.create({
      data: {
        scope: "ROOM",
        key: `f_${randomUUID().replaceAll("-", "")}`,
        name: randomUUID(),
        type: "CHOICE",
        options: { create: { label: "Existing" } },
      },
    });
    ids.push(field.id);
    const result = await runWithLocale("de", () =>
      action(
        args({
          op: "options",
          input: { fieldId: field.id, changes: [{ op: "add", label: "EXISTING" }] },
        }),
      ),
    );
    expect(result).toMatchObject({
      init: { status: 422 },
      data: { formErrors: [t("de", "fields.admin.optionTaken")] },
    });
    expect(await db.customFieldOption.count({ where: { fieldId: field.id } })).toBe(1);
  });
});

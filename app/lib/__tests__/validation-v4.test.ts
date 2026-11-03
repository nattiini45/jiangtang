import { describe, expect, it } from "vitest";
import { inviteSchema } from "~/domains/auth/users.schema";
import { stockCreateSchema } from "~/domains/inventory/inventory.stock.schema";
import { taskCsvRowSchema } from "~/domains/tasks/tasks.schema";
import { msgKey } from "~/i18n";
import { previewCsv } from "~/lib/csv/preview";
import { optionalHttpUrl, safeParse, z } from "~/lib/validation.server";

/**
 * Behaviour the zod 4 migration could change silently: which inputs pass, the catalog
 * message each refusal carries, and the shape the flattened errors take.
 */

describe("optional http URL", () => {
  const schema = z.object({ site: optionalHttpUrl });

  it("trims surrounding space before the URL check and keeps the trimmed value", () => {
    const result = safeParse(schema, { site: "  https://example.de/x  " }, "en");
    expect(result.success && result.data.site).toBe("https://example.de/x");
  });

  it("refuses a bare host with both the URL and the http-only message, a non-http scheme with the http-only one", () => {
    const bare = safeParse(schema, { site: "example.com" }, "en");
    expect(bare.success || bare.fieldErrors.site).toEqual([
      "Invalid URL.",
      "Only http(s) URLs are allowed.",
    ]);
    const scheme = safeParse(schema, { site: "javascript:alert(1)" }, "en");
    expect(scheme.success || scheme.fieldErrors.site).toEqual(["Only http(s) URLs are allowed."]);
  });
});

describe("invite email", () => {
  const invite = (email: string) => ({ email, name: "Ada", initials: "AL", role: "MEMBER" });

  it("accepts ordinary addresses and refuses malformed ones", () => {
    expect(inviteSchema.safeParse(invite("ada.lovelace+av@sub.example.org")).success).toBe(true);
    expect(inviteSchema.safeParse(invite("a..b@x.com")).success).toBe(false);
    expect(inviteSchema.safeParse(invite("x@localhost")).success).toBe(false);
  });

  it("carries the catalog message for the email field in each locale", () => {
    const en = safeParse(inviteSchema, invite("not-an-address"), "en");
    expect(en.success || en.fieldErrors.email).toEqual(["A valid email address is required."]);
    const de = safeParse(inviteSchema, invite("not-an-address"), "de");
    expect(de.success || de.fieldErrors.email).toEqual([
      "Eine gültige E-Mail-Adresse ist erforderlich.",
    ]);
  });
});

describe("error messages passed through the error parameter", () => {
  it("a task CSV status that is neither an enum value nor a label keeps its catalog key", () => {
    const row = {
      title: "Kabel prüfen",
      status: "Unbekannt",
      priority: "",
      start: "",
      due: "",
      estimate: "",
      labels: "",
      assignees: "",
      project: "",
    };
    const result = taskCsvRowSchema.safeParse(row);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        path: ["status"],
        message: msgKey("work.err.csv.statusUnknown"),
      }),
    ]);
  });

  it("an unreadable task CSV day keeps the day-format key, not zod's default text", () => {
    const row = {
      title: "Kabel prüfen",
      status: "",
      priority: "",
      start: "not a date",
      due: "",
      estimate: "",
      labels: "",
      assignees: "",
      project: "",
    };
    const result = taskCsvRowSchema.safeParse(row);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual([
      expect.objectContaining({ path: ["start"], message: msgKey("work.err.csvDayFormat") }),
    ]);
  });

  it("a stock status outside the enum and an unreadable purchase date are refused on their fields", () => {
    const status = stockCreateSchema.safeParse({ name: "Mikrofon", status: "Kaputt" });
    expect(status.success).toBe(false);
    if (!status.success) {
      expect(status.error.issues).toEqual([
        expect.objectContaining({
          path: ["status"],
          message: msgKey("places.err.stock.statusInvalid"),
        }),
      ]);
    }
    const date = stockCreateSchema.safeParse({ name: "Mikrofon", purchasedAt: "nope" });
    expect(date.success).toBe(false);
    if (!date.success) {
      expect(date.error.issues.map((i) => i.path.join("."))).toEqual(["purchasedAt"]);
    }
  });
});

describe("CSV preview", () => {
  it("splits valid and invalid rows and labels each message with its field", () => {
    const schema = z.object({
      title: z.string().min(1, msgKey("work.err.titleRequired")),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, msgKey("work.err.dateFormat")),
    });
    const preview = previewCsv("title,date\nKabel,2026-01-01\n,bad\n", schema, "en");
    expect(preview.headers).toEqual(["title", "date"]);
    expect(preview.valid).toEqual([{ line: 2, data: { title: "Kabel", date: "2026-01-01" } }]);
    expect(preview.invalid).toEqual([
      {
        line: 3,
        raw: { title: "", date: "bad" },
        messages: ["title: Title is required.", "date: Date must be in YYYY-MM-DD format."],
      },
    ]);
  });
});

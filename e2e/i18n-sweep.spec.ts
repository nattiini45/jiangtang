import { test, expect, type Page } from "@playwright/test";
import { runPrefix } from "./run";
import { db } from "~/lib/db.server";
import type { AuditActor } from "~/lib/audit.server";
import { createRoom } from "~/domains/rooms/rooms.mutations.server";
import { roomCreateSchema } from "~/domains/rooms/rooms.schema";
import { createEvent } from "~/domains/events/events.mutations.server";
import { eventCreateSchema } from "~/domains/events/events.schema";
import { createEquipment } from "~/domains/inventory/inventory.mutations.server";
import { equipmentCreateSchema } from "~/domains/inventory/inventory.schema";

/**
 * English sweep: every main desktop and `/m` route is rendered with the English
 * locale and its visible text (text nodes plus accessibility-relevant attributes)
 * must not contain German UI words.
 *
 * The e2e database is seeded in German (the rest of the suite asserts German), so
 * demo/user data legitimately shows German. Data is excluded without marking up the
 * UI: every string stored in the database is collected up front and removed from the
 * page text before the German word list is applied. What remains is chrome.
 */

const RUN = runPrefix();

const GERMAN_WORDS = [
  "Speichern",
  "Abbrechen",
  "Anlegen",
  "Angelegt",
  "Übersicht",
  "Aufgabe",
  "Aufgaben",
  "Räume",
  "Raum",
  "Standort",
  "Standorte",
  "Löschen",
  "Bearbeiten",
  "Suche",
  "Suchen",
  "Neu",
  "Neue",
  "Neuer",
  "Zurück",
  "Einstellungen",
  "Abmelden",
  "Anmelden",
  "Hinzufügen",
  "Erstellen",
  "Schließen",
  "Weiter",
  "Bestätigen",
  "Passwort",
  "Benutzer",
  "Notizen",
  "Notiz",
  "Projekte",
  "Geräte",
  "Gerät",
  "Veranstaltungen",
  "Zeiterfassung",
  "Beschreibung",
  "Priorität",
  "Fällig",
  "Erledigt",
  "Heute",
  "Woche",
  "Monat",
  "Keine",
  "Kein",
  "Alle",
  "Fehler",
  "Laden",
  "Wird",
  "Einträge",
  "Eintrag",
  "Datum",
  "Zeit",
  "Titel",
  "Mitglied",
  "Aktivität",
  "Verlauf",
  "Bestand",
  "Hörsaal",
  "Hörsäle",
  "Frequenzen",
  "Kapazität",
  "Auslastung",
  "Anhang",
  "Anhänge",
  "Filter zurücksetzen",
  "nicht",
  "und",
  "oder",
  "für",
  "mit",
  "von",
  "bitte",
];

// Lower-case function words only count as German when they stand alone between
// spaces; capitalised words are matched on word boundaries (case sensitive).
const CAPITALISED = GERMAN_WORDS.filter((w) => /^\p{Lu}/u.test(w));
const FUNCTION_WORDS = GERMAN_WORDS.filter((w) => /^\p{Ll}/u.test(w));
const GERMAN_RE = new RegExp(
  `(?<![\\p{L}])(?:${CAPITALISED.join("|")})(?![\\p{L}])|(?<=\\s)(?:${FUNCTION_WORDS.join("|")})(?=\\s)`,
  "gu",
);

/** Tables that hold credentials or opaque tokens, never UI-visible text. */
const SKIP_TABLES = new Set(["_prisma_migrations", "Session", "Account", "Verification"]);

function collectJsonStrings(value: unknown, out: Set<string>) {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) collectJsonStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectJsonStrings(v, out);
}

/** Every string value stored in the database, split into lines, longest first. */
async function loadDataStrings(): Promise<string[]> {
  const columns = await db.$queryRaw<
    { table_name: string; column_name: string; data_type: string }[]
  >`SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'ARRAY', 'jsonb', 'json')`;
  const raw = new Set<string>();
  for (const c of columns) {
    if (SKIP_TABLES.has(c.table_name)) continue;
    const col = `"${c.column_name}"`;
    const table = `"${c.table_name}"`;
    if (c.data_type === "jsonb" || c.data_type === "json") {
      const rows = await db.$queryRawUnsafe<{ v: string }[]>(
        `SELECT DISTINCT ${col}::text AS v FROM ${table} WHERE ${col} IS NOT NULL LIMIT 20000`,
      );
      for (const r of rows) {
        try {
          collectJsonStrings(JSON.parse(r.v), raw);
        } catch {
          /* not JSON text */
        }
      }
    } else if (c.data_type === "ARRAY") {
      const rows = await db.$queryRawUnsafe<{ v: string }[]>(
        `SELECT DISTINCT unnest(${col})::text AS v FROM ${table} LIMIT 20000`,
      );
      for (const r of rows) raw.add(r.v);
    } else {
      const rows = await db.$queryRawUnsafe<{ v: string }[]>(
        `SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL LIMIT 20000`,
      );
      for (const r of rows) raw.add(r.v);
    }
  }
  const out = new Set<string>();
  for (const value of raw) {
    if (value.length > 20_000) continue;
    out.add(value.trim());
    for (const line of value.split(/\r?\n/)) out.add(line.trim());
  }
  return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

/** Text a user can see or hear, as separate strings. */
async function visibleStrings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]);
    const visible = (el: Element) =>
      (el as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true }) ?? true;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      const text = n.textContent?.replace(/\s+/g, " ").trim();
      if (!el || !text || skip.has(el.tagName) || !visible(el)) continue;
      out.push(text);
    }
    for (const el of document.querySelectorAll("[aria-label],[title],[placeholder],[alt]")) {
      if (!visible(el)) continue;
      for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
        const v = el.getAttribute(attr)?.trim();
        if (v) out.push(v);
      }
    }
    if (document.title) out.push(document.title);
    return out;
  });
}

const lettersOnly = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const keyCache = new WeakMap<string[], string[]>();
function dataKeys(data: string[]): string[] {
  let keys = keyCache.get(data);
  if (!keys) keyCache.set(data, (keys = data.map(lettersOnly)));
  return keys;
}

function germanLeaks(strings: string[], data: string[]): string[] {
  const leaks: string[] = [];
  for (const original of strings) {
    let rest = original;
    // Lists and cards cut long stored text with an ellipsis and strip its markdown;
    // compare on letters and digits only and keep the pieces that are not a fragment
    // of some stored string.
    if (/…|\.\.\./.test(rest)) {
      rest = rest
        .split(/…|\.\.\./)
        .filter((piece) => {
          const key = lettersOnly(piece);
          return key.length < 4 || !dataKeys(data).some((d) => d.includes(key));
        })
        .join(" ");
    }
    for (const d of data) if (rest.includes(d)) rest = rest.split(d).join(" ");
    const hits = rest.match(GERMAN_RE);
    if (hits) leaks.push(`${JSON.stringify(original)} → ${[...new Set(hits)].join(", ")}`);
  }
  return leaks;
}
interface Ids {
  taskId: string;
  projectSlug: string;
  noteId: string;
  ticketId: string;
  eventId: string;
  roomSlug: string;
  locationId: string;
  equipmentId: string;
  modelId: string;
  stockId: string;
  memberId: string;
}

let ids: Ids;
let data: string[];

/** The demo seed has no rooms, events, equipment or models; create one of each if missing. */
async function ensureRoomsEventsEquipment(actor: AuditActor) {
  const room =
    (await db.room.findFirst({ orderBy: { id: "asc" } })) ??
    (await createRoom(actor, roomCreateSchema.parse({ name: `${RUN}Room` })));
  const event =
    (await db.event.findFirst({ orderBy: { id: "asc" } })) ??
    (await createEvent(
      actor,
      eventCreateSchema.parse({
        title: `${RUN}Event`,
        startsAt: "2030-01-15T10:00",
        endsAt: "2030-01-15T12:00",
      }),
    ));
  const model =
    (await db.equipmentModel.findFirst({ orderBy: { id: "asc" } })) ??
    (await db.equipmentModel.create({ data: { name: `${RUN}Model`, category: "PROJECTOR" } }));
  const equipment =
    (await db.equipment.findFirst({ orderBy: { id: "asc" } })) ??
    (await createEquipment(
      actor,
      equipmentCreateSchema.parse({
        category: "PROJECTOR",
        mobility: "FIXED",
        roomId: room.id,
        modelId: model.id,
        name: `${RUN}Projector`,
      }),
    ));
  return { room, event, model, equipment };
}

test.beforeAll(async () => {
  const admin = await db.user.findFirstOrThrow({ where: { email: process.env.ADMIN_EMAIL } });
  const actor: AuditActor = { id: admin.id, name: admin.name, initials: admin.initials };
  const { room, event, model, equipment } = await ensureRoomsEventsEquipment(actor);
  const [task, project, note, ticket, location, stock, member] = await Promise.all([
    db.task.findFirstOrThrow({ orderBy: { id: "asc" } }),
    db.project.findFirstOrThrow({ orderBy: { id: "asc" } }),
    db.note.findFirstOrThrow({ orderBy: { id: "asc" } }),
    db.ticket.findFirstOrThrow({ orderBy: { id: "asc" } }),
    db.location.findFirstOrThrow({ orderBy: { id: "asc" } }),
    db.inventoryItem.findFirstOrThrow({ orderBy: { id: "asc" } }),
    db.user.findFirstOrThrow({
      where: { email: { not: process.env.ADMIN_EMAIL } },
      orderBy: { id: "asc" },
    }),
  ]);
  ids = {
    taskId: task.id,
    projectSlug: project.slug,
    noteId: note.id,
    ticketId: ticket.id,
    eventId: event.id,
    roomSlug: room.slug,
    locationId: location.id,
    equipmentId: equipment.id,
    modelId: model.id,
    stockId: stock.id,
    memberId: member.id,
  };
  data = await loadDataStrings();
});
test.afterAll(async () => {
  await db.$disconnect();
});

const DESKTOP: [string, () => string][] = [
  ["dashboard", () => "/"],
  ["quick-entry", () => "/quick-entry"],
  ["tasks", () => "/tasks"],
  ["tasks new", () => "/tasks/new"],
  ["tasks import", () => "/tasks/import"],
  ["task detail", () => `/tasks/${ids.taskId}`],
  ["board", () => "/board"],
  ["projects", () => "/projects"],
  ["projects new", () => "/projects/new"],
  ["project detail", () => `/projects/${ids.projectSlug}`],
  ["project gantt", () => `/projects/${ids.projectSlug}?view=gantt`],
  ["project burndown", () => `/projects/${ids.projectSlug}?view=burndown`],
  ["project edit", () => `/projects/${ids.projectSlug}/edit`],
  ["notes", () => "/notes"],
  ["notes new", () => "/notes/new"],
  ["notes import", () => "/notes/import"],
  ["note editor", () => `/notes/${ids.noteId}`],
  ["tickets", () => "/tickets"],
  ["tickets new", () => "/tickets/new"],
  ["ticket detail", () => `/tickets/${ids.ticketId}`],
  ["events", () => "/events"],
  ["events new", () => "/events/new"],
  ["event detail", () => `/events/${ids.eventId}`],
  ["rooms", () => "/rooms"],
  ["rooms new", () => "/rooms/new"],
  ["rooms import", () => "/rooms/import"],
  ["room detail", () => `/rooms/${ids.roomSlug}`],
  ["room edit", () => `/rooms/${ids.roomSlug}/edit`],
  ["room clone", () => `/rooms/${ids.roomSlug}/clone`],
  ["locations", () => "/locations"],
  ["locations new", () => "/locations/new"],
  ["location detail", () => `/locations/${ids.locationId}`],
  ["location edit", () => `/locations/${ids.locationId}/edit`],
  ["inventory", () => "/inventory"],
  ["inventory new", () => "/inventory/new"],
  ["inventory import", () => "/inventory/import"],
  ["equipment detail", () => `/inventory/${ids.equipmentId}`],
  ["models", () => "/inventory/models"],
  ["models new", () => "/inventory/models/new"],
  ["model detail", () => `/inventory/models/${ids.modelId}`],
  ["stock", () => "/inventory/stock"],
  ["stock new", () => "/inventory/stock/new"],
  ["stock import", () => "/inventory/stock/import"],
  ["stock detail", () => `/inventory/stock/${ids.stockId}`],
  ["frequencies", () => "/frequencies"],
  ["activity", () => "/activity"],
  ["search", () => "/search?q=Lager"],
  ["search empty", () => "/search?q=zzzqqq-nothing"],
  ["timesheet", () => "/timesheet"],
  ["capacity", () => "/capacity"],
  ["analytics", () => "/analytics"],
  ["import hub", () => "/import"],
  ["admin users", () => "/admin/users"],
  ["admin users new", () => "/admin/users/new"],
  ["admin user detail", () => `/admin/users/${ids.memberId}`],
  ["admin user erase", () => `/admin/users/${ids.memberId}/erase`],
  ["admin index", () => "/admin/index"],
  ["not found", () => "/no-such-page"],
];

const MOBILE: [string, () => string][] = [
  ["m home", () => "/m"],
  ["m rooms", () => "/m/rooms"],
  ["m room detail", () => `/m/rooms/${ids.roomSlug}`],
  ["m tasks", () => "/m/tasks"],
  ["m tasks new", () => "/m/tasks/new"],
  ["m task detail", () => `/m/tasks/${ids.taskId}`],
  ["m tickets", () => "/m/tickets"],
  ["m ticket detail", () => `/m/tickets/${ids.ticketId}`],
  ["m locations", () => "/m/locations"],
  ["m stock", () => "/m/inventory/stock"],
  ["m notes new", () => "/m/notes/new"],
  ["m board", () => "/m/board"],
  ["m search", () => "/m/search?q=Lager"],
  ["m offline", () => "/m/offline"],
];

async function openEnglish(page: Page, path: string, mobile: boolean) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto(path);
  // `/no-such-page` is the one deliberate 404; everything else must load.
  if (path !== "/no-such-page") expect(response?.status(), path).toBeLessThan(400);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.waitForSelector("html[data-hydrated]", { timeout: 20_000 }).catch(() => undefined);
  // Let loaders, charts and lazy chunks settle; the SSE stream keeps the network busy.
  await page.waitForTimeout(600);
}

async function expectNoGerman(page: Page, label: string) {
  const leaks = germanLeaks(await visibleStrings(page), data);
  expect(leaks, `German UI text on ${label}`).toEqual([]);
}

test.describe("English UI has no German chrome", () => {
  test.use({ locale: "en-US" });

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  });

  for (const [name, path] of DESKTOP) {
    test(`desktop ${name}`, async ({ page }) => {
      await openEnglish(page, path(), false);
      await expectNoGerman(page, `${name} (${path()})`);
    });
  }

  for (const [name, path] of MOBILE) {
    test(`mobile ${name}`, async ({ page }) => {
      await openEnglish(page, path(), true);
      await expectNoGerman(page, `${name} (${path()})`);
    });
  }

  test("desktop command palette", async ({ page }) => {
    await openEnglish(page, "/", false);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await expectNoGerman(page, "command palette");
  });

  test("desktop validation messages", async ({ page }) => {
    await openEnglish(page, "/tasks/new", false);
    await page.locator("form:has(input[name='title']) button[type='submit']").first().click();
    await page.waitForTimeout(600);
    await expectNoGerman(page, "empty task form");
  });

  test("mobile more menu", async ({ page }) => {
    await openEnglish(page, "/m", true);
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("group", { name: "Language" })).toBeVisible();
    await expectNoGerman(page, "mobile more menu");
  });
});

test.describe("English UI without a session", () => {
  test.use({ locale: "en-US", storageState: { cookies: [], origins: [] } });

  for (const path of ["/login", "/accept-invite/no-such-token"]) {
    test(`public ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expectNoGerman(page, path);
    });
  }
});

test("the sweep detects German chrome", () => {
  const leaks = germanLeaks(["Aufgabe speichern", "Save", "Hörsaal 1 · Edit"], ["Hörsaal 1"]);
  expect(leaks).toEqual(['"Aufgabe speichern" → Aufgabe']);
});

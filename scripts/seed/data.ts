/**
 * The demo workspace. DATA ONLY — no database access.
 *
 * Two rules make this file safe to run twice:
 *
 *  1. **Every row carries an explicit, stable id**, prefixed `seed_`. Ids are
 *     `@default(cuid())`, which Prisma generates CLIENT-side, so the database
 *     holds no default to lean on — a seed that let the client mint ids could
 *     only ever append, which is precisely the silent duplication this avoids.
 *  2. **Natural keys are rejected**, because inventing one per model is a
 *     migration plus five unique indexes that this seed does not own
 *     (`InventoryItem` has no candidate key yet, so it is seeded by id only),
 *     and delete-then-insert was rejected because it destroys hand-made
 *     demo edits on a second run. `prisma/seed.ts` therefore writes a row only
 *     when its id is absent and never rewrites one that is present.
 *
 * The `EXPECTED_*` counts below are LITERALS, not derived from these arrays.
 * Deriving them would make the seed-integrity test assert that the data equals
 * itself — a green that no change to the data can turn red. `assertCountsMatchSpec()`
 * is what keeps the two in step, and it throws loudly rather than letting the
 * counts drift away from their table unnoticed.
 */
import type {
  LocationKind,
  ProjectStatus,
  StockStatus,
  TaskPriority,
  TaskStatus,
  TicketStatus,
  TicketType,
  UserRole,
} from "~/generated/prisma/enums";
import type { Prisma } from "~/generated/prisma/client";

// ── Expected row counts for the seeded corpus ───────────────

export const EXPECTED_COUNTS = {
  room: 2,
  equipmentModel: 1,
  equipment: 1,
  event: 1,
  eventRoomBooking: 1,
  location: 8,
  project: 6,
  task: 41,
  taskDependency: 4,
  taskAssignees: 24,
  ticket: 12,
  note: 8,
  inventoryItem: 31,
  vendor: 3,
  timeEntry: 6,
} as const;

/** One row per `LocationKind` value. */
export const EXPECTED_LOCATION_KIND_COUNT = 8;

/**
 * 3 demo `User`s — they satisfy the `NOT NULL` FKs and staff the demo's
 * capacity view, and they can never authenticate because none has an `Account`
 * row (a credential barrier, unchanged).
 */
export const EXPECTED_DEMO_USER_COUNT = 3;

/** Every seeded row's id starts with this, so the test can tell demo from ambient. */
export const SEED_ID_PREFIX = "seed_";

export const ROOMS = [
  {
    id: "seed_room_a01",
    slug: "demo-a01",
    name: "Demo-Raum A.01",
    roomNumber: "A.01",
    capacity: 40,
    hasProjector: true,
    videoInputs: ["HDMI"],
    audioOutputs: [],
    status: "MAINTENANCE_NEEDED",
    knownIssues:
      "HDMI am Pult hat einen Wackelkontakt. Bis zum Tausch den zweiten Eingang verwenden.",
    tipsNotes: "Die Fernbedienung liegt in der Schublade am Pult.",
    lastCheckedAt: new Date("2026-10-20T10:00:00Z"),
  },
  {
    id: "seed_room_a02",
    slug: "demo-a02",
    name: "Demo-Raum A.02",
    roomNumber: "A.02",
    capacity: 60,
    status: "PROVISIONAL",
    knownIssues: "Funkmikrofon rauscht gelegentlich. Ersatzbatterien liegen im Pult.",
    tipsNotes: "Nach dem Einschalten den Ton am Pult freigeben.",
    lastCheckedAt: new Date("2026-10-22T08:30:00Z"),
    videoInputs: [],
    audioOutputs: [],
  },
] satisfies Prisma.RoomCreateManyInput[];

export const EQUIPMENT_MODELS = [
  {
    id: "seed_model_projector",
    manufacturer: "Demo",
    name: "Demo-Projektor",
    category: "PROJECTOR",
  },
] satisfies Prisma.EquipmentModelCreateManyInput[];

export const EQUIPMENT = [
  {
    id: "seed_equipment_projector_a01",
    name: "Projektor A.01",
    roomId: "seed_room_a01",
    modelId: "seed_model_projector",
    category: "PROJECTOR",
    mobility: "FIXED",
    status: "OPERATIONAL",
  },
] satisfies Prisma.EquipmentCreateManyInput[];

export const EVENTS = [
  {
    id: "seed_event_hybrid",
    uid: "seed_event_hybrid",
    title: "Demo-Hybridveranstaltung",
    offsetDays: 0,
    startHour: 10,
    endHour: 12,
  },
];

export const EVENT_ROOM_BOOKINGS = [
  { id: "seed_booking_a01", eventId: "seed_event_hybrid", roomId: "seed_room_a01" },
];

// ── The demo user ───────────────────────────────────────────────────

/**
 * Three demo team members: `isActive: true` so the capacity view and the
 * task pickers are populated, but **no `Account` row**, so none of them can
 * ever authenticate — `bootstrapFirstAdmin`/`signUpEmail` were rejected because
 * a demo fixture that mints a credential is a credential
 * in the repository. The no-Account barrier is what makes them inert, not the
 * flags; `isActive` now reflects that they are *supposed* to appear as staff.
 *
 * `DEMO_USER` has the stable fixture id `seed_user_demo`, which other seed
 * rows reference.
 */
export const DEMO_USER = {
  id: "seed_user_demo",
  email: "alex@example.test",
  name: "Demo Alex",
  initials: "AX",
  role: "MEMBER" as UserRole,
  isActive: true,
  emailVerified: false,
  weeklyCapacityMinutes: 2310, // 38,5 h
} as const;

const DEMO_USER_MK = {
  id: "seed_user_blair",
  email: "blair@example.test",
  name: "Demo Blair",
  initials: "BL",
  role: "MEMBER" as UserRole,
  isActive: true,
  emailVerified: false,
  weeklyCapacityMinutes: 1800, // 30 h
} as const;

const DEMO_USER_JS = {
  id: "seed_user_casey",
  email: "casey@example.test",
  name: "Demo Casey",
  initials: "CY",
  role: "MEMBER" as UserRole,
  isActive: true,
  emailVerified: false,
  weeklyCapacityMinutes: 1200, // 20 h — deliberately overloaded in week +1/+2
} as const;

/** The whole demo team; `DEMO_USER` is exported on its own for the seed actor. */
export const DEMO_TEAM = [DEMO_USER, DEMO_USER_MK, DEMO_USER_JS] as const;

// ── Europe/Berlin wall-clock helpers ─────────────────────────────────────────

const BERLIN = "Europe/Berlin";

/** Berlin's UTC offset, in minutes, at `at` (DST-correct by construction). */
function berlinOffsetMinutes(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: BERLIN,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000;
}

/**
 * The instant at which the Berlin wall clock reads `hour:00`, `days` days from
 * today. Anchored to Berlin rather than to UTC so the demo's due dates land on
 * working hours in the timezone the whole product runs in (golden rule: all
 * times are Europe/Berlin). Relative rather than absolute so a seeded workspace
 * always looks current, which is the point of the demo seed.
 */
export function atBerlinHour(days: number, hour = 9): Date {
  const approx = new Date(Date.now() + days * 86_400_000);
  const anchor = new Date(
    Date.UTC(approx.getUTCFullYear(), approx.getUTCMonth(), approx.getUTCDate(), hour, 0, 0),
  );
  return new Date(anchor.getTime() - berlinOffsetMinutes(anchor) * 60_000);
}

const ISO_WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/**
 * The instant at which the Berlin wall clock reads `hour:00` on `weekday`
 * (0 = Monday … 6 = Sunday) of the CURRENT Berlin ISO week. Unlike a raw
 * day offset this lands inside the current week no matter which weekday the
 * seed runs on — that is what the demo `TimeEntry` rows need: a timesheet for
 * „diese Woche" that is never empty and never spills into last week.
 */
export function atBerlinHourThisWeek(weekday: number, hour = 9): Date {
  const today = new Intl.DateTimeFormat("en-US", { timeZone: BERLIN, weekday: "short" }).format(
    new Date(),
  );
  const offset = weekday - (ISO_WEEKDAY_INDEX[today] ?? 0);
  return atBerlinHour(offset, hour);
}

// ── Locations: one per `LocationKind`, and a real tree ────────────────────────

type LocationSeed = {
  id: string;
  name: string;
  code: string;
  kind: LocationKind;
  address: string | null;
  description: string;
  parentId: string | null;
};

export const LOCATIONS: readonly LocationSeed[] = [
  {
    id: "seed_loc_site_campus",
    name: "Demo-Standort",
    code: "DEMO",
    kind: "SITE",
    address: null,
    description: "Zentraler Demo-Standort für den AV-Betrieb.",
    parentId: null,
  },
  {
    id: "seed_loc_building_b",
    name: "Demo-Gebäude A",
    code: "DEMO-A",
    kind: "BUILDING",
    address: null,
    description: "Technikflächen und Demo-Räume.",
    parentId: "seed_loc_site_campus",
  },
  {
    id: "seed_loc_room_a01",
    name: "Demo-Raum A.01",
    code: "A.01",
    kind: "ROOM",
    address: null,
    description: "Referenzraum für Streaming- und Funkmikrofon-Tests.",
    parentId: "seed_loc_building_b",
  },
  {
    id: "seed_loc_storage_avlager",
    name: "Demo-Lager",
    code: "DEMO-LAGER",
    kind: "STORAGE",
    address: null,
    description: "Zentrale Lagerfläche für Verbrauchs- und Reparaturmaterial.",
    parentId: "seed_loc_site_campus",
  },
  {
    id: "seed_loc_rack_demo_1",
    name: "Demo-Rack 1",
    code: "DEMO-RACK-1",
    kind: "RACK",
    address: null,
    description: "Patchfeld und Netzwerkverteilung.",
    parentId: "seed_loc_storage_avlager",
  },
  {
    id: "seed_loc_vehicle_demo_kfz1",
    name: "Demo-Transporter",
    code: "DEMO-KFZ-1",
    kind: "VEHICLE",
    address: null,
    description: "Einsatzfahrzeug für Außentermine und Notdienste.",
    parentId: "seed_loc_site_campus",
  },
  {
    id: "seed_loc_external_demo",
    name: "Demo-Verleihstandort",
    code: "DEMO-EXT",
    kind: "EXTERNAL",
    address: null,
    description: "Externe Lieferantenfläche; Wareneingang und Abholung.",
    parentId: null,
  },
  {
    id: "seed_loc_virtual_hybrid",
    name: "Demo-Hybrid-Instanz",
    code: "DEMO-HYBRID",
    kind: "VIRTUAL",
    address: null,
    description: "Streaming-Ziel ohne physischen Ort.",
    parentId: null,
  },
];

// ── Vendors (3) ──────────────────────────────────────────────────────────────

type VendorSeed = {
  id: string;
  name: string;
  contact: string;
  email: string;
  phone: string;
  url: string;
  address: string | null;
  locationId: string | null;
};

export const VENDORS: readonly VendorSeed[] = [
  {
    id: "seed_vendor_demo_rental",
    name: "Demo-Technik Nord GmbH",
    contact: "Demo Kontakt A",
    email: "service@demo-technik.example",
    phone: "+49 000 0000001",
    url: "https://demo-technik.example",
    address: null,
    locationId: "seed_loc_external_demo",
  },
  {
    id: "seed_vendor_buero",
    name: "Demo-Bürotechnik GmbH",
    contact: "Demo Kontakt B",
    email: "verkauf@demo-buero.example",
    phone: "+49 000 0000002",
    url: "https://demo-buero.example",
    address: null,
    locationId: "seed_loc_external_demo",
  },
  {
    id: "seed_vendor_demo_parts",
    name: "Demo-Ersatzteile GmbH",
    contact: "Demo Kontakt C",
    email: "ersatzteile@demo-ersatzteile.example",
    phone: "+49 000 0000003",
    url: "https://demo-ersatzteile.example",
    address: null,
    locationId: "seed_loc_storage_avlager",
  },
];

// ── Projects (6) — one parent project, five children ─────────────────────────

type ProjectSeed = {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: ProjectStatus;
  color: string;
  startOffsetDays: number | null;
  dueOffsetDays: number;
  parentProjectId: string | null;
};

export const PROJECTS: readonly ProjectSeed[] = [
  {
    id: "seed_proj_hoersaaltechnik",
    name: "Raumtechnik Demo",
    slug: "hoersaaltechnik-ws2425",
    description: "Grundversorgung der Demo-Räume: Ausstattung, Reparatur, Dokumentation.",
    status: "CONFIRMED",
    color: "#2f6feb",
    startOffsetDays: -70,
    dueOffsetDays: 45,
    parentProjectId: null,
  },
  {
    id: "seed_proj_streaming",
    name: "Beschaffung Streaming",
    slug: "beschaffung-streaming",
    description: "Encoder, Netzwerk und Betriebskonzept für die Hybrid-Lehre.",
    status: "REQUESTED",
    color: "#7c3aed",
    startOffsetDays: -14,
    dueOffsetDays: 120,
    parentProjectId: "seed_proj_hoersaaltechnik",
  },
  {
    id: "seed_proj_logistik",
    name: "Lager & Logistik",
    slug: "lager-logistik",
    description: "Bestandsführung, Regalstruktur und Materialbeschaffung.",
    status: "CONFIRMED",
    color: "#0f766e",
    startOffsetDays: -60,
    dueOffsetDays: 90,
    parentProjectId: "seed_proj_hoersaaltechnik",
  },
  {
    id: "seed_proj_veranstaltung",
    name: "Veranstaltungssaison 2025",
    slug: "veranstaltungssaison-2025",
    description: "Ringvorlesungen, Open-Air-Termine und interne Produktionen.",
    status: "REQUESTED",
    color: "#b45309",
    startOffsetDays: -30,
    dueOffsetDays: 180,
    parentProjectId: "seed_proj_hoersaaltechnik",
  },
  {
    id: "seed_proj_wartung",
    name: "Wartung & Instandhaltung",
    slug: "wartung-instandhaltung",
    description: "Präventive Wartung, Jahresprüfung und Ersatzteilstrategie.",
    status: "CONFIRMED",
    color: "#be123c",
    startOffsetDays: -90,
    dueOffsetDays: 30,
    parentProjectId: "seed_proj_hoersaaltechnik",
  },
  {
    id: "seed_proj_campus_sued",
    name: "Standort-Erweiterung",
    slug: "campus-ausbau-sued",
    description: "Vorstudie zur AV-Ausstattung des Demo-Erweiterungsbaus.",
    status: "AWAITING_FEEDBACK",
    color: "#52525b",
    startOffsetDays: null,
    dueOffsetDays: 240,
    parentProjectId: "seed_proj_hoersaaltechnik",
  },
];

// ── Tasks (40) — every `TaskStatus` and every `TaskPriority` occurs at least once ──

type TaskSeed = {
  id: string;
  title: string;
  /** Optional today; the field exists so a note-carrying task needs no shape change. */
  body?: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  parentTaskId: string | null;
  locationId: string | null;
  estimateMinutes: number | null;
  position: number;
  dueOffsetDays: number | null;
  /**
   * undefined → the writer places the bar start at `dueOffsetDays - 14`;
   * null → due-only task (renders as a milestone in the gantt).
   */
  startOffsetDays?: number | null;
  labels: readonly string[];
};

export const TASKS: readonly TaskSeed[] = [
  // Hörsaaltechnik (9)
  {
    id: "seed_task_hs_01",
    title: "Beamer-Vergleich 2025 durchführen",
    status: "IN_PROGRESS",
    priority: "HIGH",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: null,
    locationId: "seed_loc_room_a01",
    estimateMinutes: 180,
    position: 1000,
    dueOffsetDays: 12,
    labels: ["hoersaal", "hardware"],
  },
  {
    id: "seed_task_hs_02",
    title: "Demo-Räume A.01–A.12 inventarisieren",
    status: "TODO",
    priority: "MEDIUM",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 480,
    position: 2000,
    dueOffsetDays: 24,
    labels: ["inventur"],
  },
  {
    id: "seed_task_hs_03",
    title: "Routenkonzept für Streaming-Angebote ausarbeiten",
    status: "BACKLOG",
    priority: "LOW",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 240,
    position: 3000,
    dueOffsetDays: 60,
    labels: ["streaming"],
  },
  {
    id: "seed_task_hs_04",
    title: "Auflösung der Demo-Räume A.01 dokumentieren",
    status: "IN_REVIEW",
    priority: "HIGH",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 120,
    position: 4000,
    dueOffsetDays: 6,
    labels: ["doku"],
  },
  {
    id: "seed_task_hs_05",
    title: "Funkmikrofone in Demo-Raum A.01 nachrüsten",
    status: "BLOCKED",
    priority: "HIGH",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: null,
    locationId: "seed_loc_room_a01",
    estimateMinutes: 300,
    position: 5000,
    dueOffsetDays: 8,
    labels: ["funk", "beschaffung"],
  },
  {
    id: "seed_task_hs_06",
    title: "Erstinbetriebnahme Dokumentenkamera Demo-Raum A.01",
    status: "DONE",
    priority: "MEDIUM",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: null,
    locationId: "seed_loc_room_a01",
    estimateMinutes: 90,
    position: 6000,
    dueOffsetDays: -20,
    labels: ["inbetriebnahme"],
  },
  {
    id: "seed_task_hs_07",
    title: "Leinwandreinigung turnusmäßig beauftragen",
    status: "DONE",
    priority: "LOW",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 60,
    position: 7000,
    dueOffsetDays: -28,
    labels: ["wartung"],
  },
  {
    id: "seed_task_hs_08",
    title: "Ausfall Beamer A.05 – Ersatzgerät bereitstellen",
    status: "TODO",
    priority: "URGENT",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 240,
    position: 8000,
    dueOffsetDays: 2,
    labels: ["störung"],
  },
  {
    id: "seed_task_hs_09",
    title: "Auflösungswerte Demo-Raum A.01 messen und eintragen",
    status: "TODO",
    priority: "MEDIUM",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: "seed_task_hs_04",
    locationId: null,
    estimateMinutes: 150,
    position: 9000,
    dueOffsetDays: 14,
    labels: ["doku", "messung"],
  },
  // Due-only → renders as a milestone diamond in the project gantt.
  {
    id: "seed_task_hs_10",
    title: "Abnahme Hörsaal-Grundausstattung",
    status: "TODO",
    priority: "HIGH",
    projectId: "seed_proj_hoersaaltechnik",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: null,
    position: 9500,
    dueOffsetDays: 16,
    startOffsetDays: null,
    labels: ["abnahme"],
  },

  // Beschaffung Streaming (6)
  {
    id: "seed_task_st_01",
    title: "Streaming-Encoder für den Demo-Betrieb evaluieren",
    status: "BACKLOG",
    priority: "MEDIUM",
    projectId: "seed_proj_streaming",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 480,
    position: 1000,
    dueOffsetDays: 40,
    labels: ["streaming", "beschaffung"],
  },
  {
    id: "seed_task_st_02",
    title: "Angebote für AV-Encoder einholen",
    status: "TODO",
    priority: "HIGH",
    projectId: "seed_proj_streaming",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 360,
    position: 2000,
    dueOffsetDays: 21,
    labels: ["beschaffung"],
  },
  {
    id: "seed_task_st_03",
    title: "Streaming-Infrastruktur Standort-Erweiterung planen",
    status: "TODO",
    priority: "HIGH",
    projectId: "seed_proj_streaming",
    parentTaskId: null,
    locationId: "seed_loc_virtual_hybrid",
    estimateMinutes: 600,
    position: 3000,
    dueOffsetDays: 75,
    labels: ["streaming", "planung"],
  },
  {
    id: "seed_task_st_04",
    title: "Förderantrag Mittelzuweisung einreichen",
    status: "BLOCKED",
    priority: "MEDIUM",
    projectId: "seed_proj_streaming",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 300,
    position: 4000,
    dueOffsetDays: 35,
    labels: ["förderung"],
  },
  {
    id: "seed_task_st_05",
    title: "Testaufbau Hybrid-Lehre realisieren",
    status: "DONE",
    priority: "HIGH",
    projectId: "seed_proj_streaming",
    parentTaskId: null,
    locationId: "seed_loc_room_a01",
    estimateMinutes: 480,
    position: 5000,
    dueOffsetDays: -12,
    labels: ["streaming", "test"],
  },
  {
    id: "seed_task_st_06",
    title: "Betriebshandbuch Streaming ergänzen",
    status: "BACKLOG",
    priority: "LOWEST",
    projectId: "seed_proj_streaming",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 240,
    position: 6000,
    dueOffsetDays: 95,
    labels: ["doku"],
  },

  // Lager & Logistik (7)
  {
    id: "seed_task_lg_01",
    title: "Lagerbestand Kabel und Adapter inventarisieren",
    status: "IN_PROGRESS",
    priority: "MEDIUM",
    projectId: "seed_proj_logistik",
    parentTaskId: null,
    locationId: "seed_loc_storage_avlager",
    estimateMinutes: 300,
    position: 1000,
    dueOffsetDays: 9,
    labels: ["inventur"],
  },
  {
    id: "seed_task_lg_02",
    title: "Regal-Layout in Demo-Rack 1 optimieren",
    status: "TODO",
    priority: "MEDIUM",
    projectId: "seed_proj_logistik",
    parentTaskId: null,
    locationId: "seed_loc_rack_demo_1",
    estimateMinutes: 240,
    position: 2000,
    dueOffsetDays: 17,
    labels: ["lager"],
  },
  {
    id: "seed_task_lg_03",
    title: "Etikettendrucker ersetzen",
    status: "DONE",
    priority: "LOW",
    projectId: "seed_proj_logistik",
    parentTaskId: null,
    locationId: "seed_loc_storage_avlager",
    estimateMinutes: 120,
    position: 3000,
    dueOffsetDays: -25,
    labels: ["lager"],
  },
  {
    id: "seed_task_lg_04",
    title: "Verbrauchsmaterialbestellung für die Heizungsperiode",
    status: "TODO",
    priority: "LOW",
    projectId: "seed_proj_logistik",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 90,
    position: 4000,
    dueOffsetDays: 5,
    labels: ["bestellung"],
  },
  {
    id: "seed_task_lg_05",
    title: "Inventurdifferenz des laufenden Quartals aufklären",
    status: "IN_REVIEW",
    priority: "HIGH",
    projectId: "seed_proj_logistik",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 180,
    position: 5000,
    dueOffsetDays: 4,
    labels: ["inventur", "prüfung"],
  },
  {
    id: "seed_task_lg_06",
    title: "Sonderlager für Veranstaltungstechnik anlegen",
    status: "BACKLOG",
    priority: "MEDIUM",
    projectId: "seed_proj_logistik",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 360,
    position: 6000,
    dueOffsetDays: 55,
    labels: ["lager", "veranstaltung"],
  },
  {
    id: "seed_task_lg_07",
    title: "TÜV-Termin für Demo-Transporter koordinieren",
    status: "DONE",
    priority: "MEDIUM",
    projectId: "seed_proj_logistik",
    parentTaskId: null,
    locationId: "seed_loc_vehicle_demo_kfz1",
    estimateMinutes: 60,
    position: 7000,
    dueOffsetDays: -18,
    labels: ["fahrzeug"],
  },

  // Veranstaltungssaison (8)
  {
    id: "seed_task_vs_01",
    title: "Absicherung Ringvorlesung – Personalplan",
    status: "IN_PROGRESS",
    priority: "HIGH",
    projectId: "seed_proj_veranstaltung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 480,
    position: 1000,
    dueOffsetDays: 3,
    labels: ["veranstaltung", "planung"],
  },
  {
    id: "seed_task_vs_02",
    title: "Technik-Rider für die Mathe-Tage erstellen",
    status: "TODO",
    priority: "HIGH",
    projectId: "seed_proj_veranstaltung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 360,
    position: 2000,
    dueOffsetDays: 11,
    labels: ["rider"],
  },
  {
    id: "seed_task_vs_03",
    title: "Stromplanung Demo-Sommerfest",
    status: "TODO",
    priority: "URGENT",
    projectId: "seed_proj_veranstaltung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 900,
    position: 3000,
    dueOffsetDays: 7,
    labels: ["open-air", "strom"],
  },
  {
    id: "seed_task_vs_04",
    title: "Moderationsübergabe finalisieren",
    status: "BLOCKED",
    priority: "MEDIUM",
    projectId: "seed_proj_veranstaltung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 180,
    position: 4000,
    dueOffsetDays: 19,
    labels: ["produktion"],
  },
  {
    id: "seed_task_vs_05",
    title: "Notfallkoffer für Außeneinsätze packen",
    status: "TODO",
    priority: "MEDIUM",
    projectId: "seed_proj_veranstaltung",
    parentTaskId: null,
    locationId: "seed_loc_vehicle_demo_kfz1",
    estimateMinutes: 240,
    position: 5000,
    dueOffsetDays: 6,
    labels: ["notfall"],
  },
  {
    id: "seed_task_vs_06",
    title: "Beschallungsplan Demo-Foyer prüfen",
    status: "IN_REVIEW",
    priority: "HIGH",
    projectId: "seed_proj_veranstaltung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 300,
    position: 6000,
    dueOffsetDays: 5,
    labels: ["beschallung"],
  },
  {
    id: "seed_task_vs_07",
    title: "Probebetrieb mit der Beleuchtung buchen",
    status: "DONE",
    priority: "MEDIUM",
    projectId: "seed_proj_veranstaltung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 240,
    position: 7000,
    dueOffsetDays: -10,
    labels: ["licht"],
  },
  {
    id: "seed_task_vs_08",
    title: "Saison 2025 retrospektiv auswerten",
    status: "BACKLOG",
    priority: "LOWEST",
    projectId: "seed_proj_veranstaltung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 120,
    position: 8000,
    dueOffsetDays: 150,
    labels: ["retrospektive"],
  },

  // Wartung & Instandhaltung (8)
  {
    id: "seed_task_wa_01",
    title: "Wartungsplan 2025 aufstellen",
    status: "IN_PROGRESS",
    priority: "MEDIUM",
    projectId: "seed_proj_wartung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 300,
    position: 1000,
    dueOffsetDays: 10,
    labels: ["wartung", "planung"],
  },
  {
    id: "seed_task_wa_02",
    title: "Firmware-Update-Verteilung dokumentieren",
    status: "TODO",
    priority: "MEDIUM",
    projectId: "seed_proj_wartung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 180,
    position: 2000,
    dueOffsetDays: 26,
    labels: ["doku", "update"],
  },
  {
    id: "seed_task_wa_03",
    title: "Notstromautomatik getestet",
    status: "DONE",
    priority: "HIGH",
    projectId: "seed_proj_wartung",
    parentTaskId: null,
    locationId: "seed_loc_rack_demo_1",
    estimateMinutes: 120,
    position: 3000,
    dueOffsetDays: -22,
    labels: ["strom", "test"],
  },
  {
    id: "seed_task_wa_04",
    title: "Wasserschaden Demo-Raum A.02 – Trocknung beauftragen",
    status: "TODO",
    priority: "URGENT",
    projectId: "seed_proj_wartung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 60,
    position: 4000,
    dueOffsetDays: 1,
    labels: ["schaden", "dringend"],
  },
  {
    id: "seed_task_wa_05",
    title: "Klimatisierung Kellerraum – Projekt zurückgestellt",
    status: "CANCELLED",
    priority: "LOWEST",
    projectId: "seed_proj_wartung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: null,
    position: 5000,
    dueOffsetDays: null,
    labels: ["klima"],
  },
  {
    id: "seed_task_wa_06",
    title: "Kabelwege auf Brandschutzvorschriften prüfen",
    status: "BACKLOG",
    priority: "MEDIUM",
    projectId: "seed_proj_wartung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 420,
    position: 6000,
    dueOffsetDays: 70,
    labels: ["brandschutz"],
  },
  {
    id: "seed_task_wa_07",
    title: "Ersatzteilpaket Beamerhalterungen bestellen",
    status: "TODO",
    priority: "HIGH",
    projectId: "seed_proj_wartung",
    parentTaskId: null,
    locationId: "seed_loc_storage_avlager",
    estimateMinutes: 90,
    position: 7000,
    dueOffsetDays: 13,
    labels: ["ersatzteil"],
  },
  {
    id: "seed_task_wa_08",
    title: "Checkliste der Jahresprüfung abschließen",
    status: "IN_REVIEW",
    priority: "MEDIUM",
    projectId: "seed_proj_wartung",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 150,
    position: 8000,
    dueOffsetDays: 4,
    labels: ["prüfung"],
  },

  // Standort-Erweiterung (2)
  {
    id: "seed_task_su_01",
    title: "Raumkonzept für das Demo-Forum skizzieren",
    status: "BACKLOG",
    priority: "LOW",
    projectId: "seed_proj_campus_sued",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 360,
    position: 1000,
    dueOffsetDays: 160,
    labels: ["planung"],
  },
  {
    id: "seed_task_su_02",
    title: "Fördermittel-Recherche Standort-Erweiterung",
    status: "BACKLOG",
    priority: "LOWEST",
    projectId: "seed_proj_campus_sued",
    parentTaskId: null,
    locationId: null,
    estimateMinutes: 240,
    position: 2000,
    dueOffsetDays: 130,
    labels: ["förderung", "recherche"],
  },
];

// ── Task dependencies — `blockedByTaskId` is the BLOCKED task; `blockingTaskId`
// the one that must finish first. Every BLOCKED task above has a blocker
// here, so the seed's own statuses are coherent.
export const TASK_DEPENDENCIES = [
  { blockedByTaskId: "seed_task_hs_05", blockingTaskId: "seed_task_hs_01" },
  { blockedByTaskId: "seed_task_st_04", blockingTaskId: "seed_task_st_03" },
  { blockedByTaskId: "seed_task_vs_04", blockingTaskId: "seed_task_vs_02" },
  { blockedByTaskId: "seed_task_su_02", blockingTaskId: "seed_task_su_01" },
] as const;

// ── Task assignees — the demo load is spread across the three team members so
// `/capacity` shows a realistic mix. `estimateMinutes` is the assignee's
// share, independent of the task's total.
//
// The Casey column is deliberately overloaded: their six tasks all due at offsets
// +8…+13 land inside at most two adjacent ISO weeks no matter which weekday the
// seed runs, totalling 2 730 min against a 1 200 min week — so at least one
// capacity cell is over capacity on every fresh database.
export const TASK_ASSIGNEES = [
  // Demo Alex — 38,5 h: the near-term urgent and review work (~1 985 min).
  { taskId: "seed_task_wa_04", userId: DEMO_USER.id, estimateMinutes: 45 },
  { taskId: "seed_task_hs_08", userId: DEMO_USER.id, estimateMinutes: 240 },
  { taskId: "seed_task_vs_01", userId: DEMO_USER.id, estimateMinutes: 300 },
  { taskId: "seed_task_lg_05", userId: DEMO_USER.id, estimateMinutes: 120 },
  { taskId: "seed_task_wa_08", userId: DEMO_USER.id, estimateMinutes: 150 },
  { taskId: "seed_task_vs_06", userId: DEMO_USER.id, estimateMinutes: 200 },
  { taskId: "seed_task_hs_04", userId: DEMO_USER.id, estimateMinutes: 90 },
  { taskId: "seed_task_vs_03", userId: DEMO_USER.id, estimateMinutes: 300 },
  { taskId: "seed_task_st_02", userId: DEMO_USER.id, estimateMinutes: 180 },
  { taskId: "seed_task_hs_02", userId: DEMO_USER.id, estimateMinutes: 240 },
  { taskId: "seed_task_wa_02", userId: DEMO_USER.id, estimateMinutes: 120 },
  // Demo Blair — 30 h: the mid-horizon planning load.
  { taskId: "seed_task_vs_05", userId: DEMO_USER_MK.id, estimateMinutes: 120 },
  { taskId: "seed_task_hs_09", userId: DEMO_USER_MK.id, estimateMinutes: 150 },
  { taskId: "seed_task_lg_02", userId: DEMO_USER_MK.id, estimateMinutes: 240 },
  { taskId: "seed_task_vs_04", userId: DEMO_USER_MK.id, estimateMinutes: 180 },
  { taskId: "seed_task_st_04", userId: DEMO_USER_MK.id, estimateMinutes: 200 },
  { taskId: "seed_task_st_01", userId: DEMO_USER_MK.id, estimateMinutes: 240 },
  { taskId: "seed_task_lg_06", userId: DEMO_USER_MK.id, estimateMinutes: 180 },
  // Demo Casey — 20 h: the +8…+13 cluster (over capacity in at least one week).
  { taskId: "seed_task_hs_05", userId: DEMO_USER_JS.id, estimateMinutes: 480 },
  { taskId: "seed_task_lg_01", userId: DEMO_USER_JS.id, estimateMinutes: 450 },
  { taskId: "seed_task_wa_01", userId: DEMO_USER_JS.id, estimateMinutes: 450 },
  { taskId: "seed_task_vs_02", userId: DEMO_USER_JS.id, estimateMinutes: 450 },
  { taskId: "seed_task_hs_01", userId: DEMO_USER_JS.id, estimateMinutes: 480 },
  { taskId: "seed_task_wa_07", userId: DEMO_USER_JS.id, estimateMinutes: 420 },
] as const;

// ── Loading-admin assignments — written ONLY when the seed runs with a
// real actor, i.e. from the dashboard's „Demo-Workspace laden". `pnpm db:seed`
// has no actor and skips this block. The picks are open demo work that shows up
// on the loader's „Meine Arbeit" card.
export const ADMIN_SEED_ASSIGNMENTS = [
  { taskId: "seed_task_hs_08", estimateMinutes: 120 },
  { taskId: "seed_task_wa_04", estimateMinutes: 45 },
  { taskId: "seed_task_vs_01", estimateMinutes: 240 },
  { taskId: "seed_task_lg_05", estimateMinutes: 120 },
  { taskId: "seed_task_st_02", estimateMinutes: 180 },
] as const;

export const ADMIN_SEED_TICKET_IDS = ["seed_tkt_01", "seed_tkt_02"] as const;

// ── Tickets (12) — every `TicketType` and every `TicketStatus` occurs ─────────

type TicketSeed = {
  id: string;
  type: TicketType;
  status: TicketStatus;
  title: string;
  description: string | null;
  resolution: string | null;
  priority: number | null;
  taskId: string | null;
  occurredOffsetDays: number;
};

export const TICKETS: readonly TicketSeed[] = [
  {
    id: "seed_tkt_01",
    type: "INCIDENT",
    status: "OPEN",
    title: "Beamer A.05 bleibt dunkel",
    description: "Kein Bild beim Start, HDMI-Eingang blinkt.",
    resolution: null,
    priority: 1,
    taskId: "seed_task_hs_08",
    occurredOffsetDays: -1,
  },
  {
    id: "seed_tkt_02",
    type: "INCIDENT",
    status: "IN_PROGRESS",
    title: "Funkmikrofone in Demo-Raum A.01 rauschen",
    description: "Dauerhaftes Grundrauschen auf Kanal 3 und 4.",
    resolution: null,
    priority: 2,
    taskId: "seed_task_hs_05",
    occurredOffsetDays: -3,
  },
  {
    id: "seed_tkt_03",
    type: "REPAIR",
    status: "RESOLVED",
    title: "Leinwand in Demo-Raum A.01 ersetzt",
    description: "Zugband gerissen.",
    resolution: "Neue Leinwand 4:3 montiert und justiert.",
    priority: null,
    taskId: "seed_task_hs_06",
    occurredOffsetDays: -26,
  },
  {
    id: "seed_tkt_04",
    type: "REQUEST",
    status: "OPEN",
    title: "Zusätzliche Steckdosen im Demo-Foyer",
    description:
      "Für die Beschallung beim Demo-Sommerfest werden zusätzliche Steckdosen gebraucht — siehe Anhang.",
    resolution: null,
    priority: 3,
    taskId: "seed_task_vs_06",
    occurredOffsetDays: -6,
  },
  {
    id: "seed_tkt_05",
    type: "INCIDENT",
    status: "RESOLVED",
    title: "Wasserschaden Demo-Raum A.02 gemeldet",
    description: "Decke durchfeuchtet, Fläche etwa 2×3 m.",
    resolution: "Trocknungsgerät aufgestellt, Raum gesperrt.",
    priority: 1,
    taskId: "seed_task_wa_04",
    occurredOffsetDays: -2,
  },
  {
    id: "seed_tkt_06",
    type: "REQUEST",
    status: "IN_PROGRESS",
    title: "Notfallkoffer auffüllen",
    description: "Material im Koffer ist aufgebraucht.",
    resolution: null,
    priority: 3,
    taskId: "seed_task_vs_05",
    occurredOffsetDays: -8,
  },
  {
    id: "seed_tkt_07",
    type: "INCIDENT",
    status: "OPEN",
    title: "Beamer Demo-Raum A.01 flackert",
    description: "Bild flackert nach etwa zehn Minuten.",
    resolution: null,
    priority: 2,
    taskId: null,
    occurredOffsetDays: -4,
  },
  {
    id: "seed_tkt_08",
    type: "REPAIR",
    status: "RESOLVED",
    title: "Router im Demo-Rack 1 ersetzt",
    description: "Ausfall der Netzwerkverteilung.",
    resolution: "Ersatzgerät getauscht, Konfiguration übernommen.",
    priority: 1,
    taskId: null,
    occurredOffsetDays: -34,
  },
  {
    id: "seed_tkt_09",
    type: "REQUEST",
    status: "CANCELLED",
    title: "Anschaffung Streaming-Encoder zurückgestellt",
    description: "Bis zur Förderentscheidung verschoben.",
    resolution: "Zurückgestellt, Wiedervorlage nach Förderbescheid.",
    priority: null,
    taskId: "seed_task_st_02",
    occurredOffsetDays: -19,
  },
  {
    id: "seed_tkt_10",
    type: "INCIDENT",
    status: "IN_PROGRESS",
    title: "Steuerung Demo-Foyer reagiert nicht",
    description: "Fritzbox und Steuerung ohne Verbindung.",
    resolution: null,
    priority: 1,
    taskId: "seed_task_vs_06",
    occurredOffsetDays: -1,
  },
  {
    id: "seed_tkt_11",
    type: "REQUEST",
    status: "OPEN",
    title: "Zugang Standort-Erweiterung für externe Technik freigeben",
    description: "Aufbau für die Open-Air-Veranstaltung am Demo-Forum.",
    resolution: null,
    priority: 3,
    taskId: null,
    occurredOffsetDays: -5,
  },
  {
    id: "seed_tkt_12",
    type: "REPAIR",
    status: "RESOLVED",
    title: "Dokumentenkamera Demo-Raum A.01 defekt",
    description: "Bild ruckelt stark.",
    resolution: "Ersatzgerät geliefert und in Betrieb genommen.",
    priority: 4,
    taskId: "seed_task_hs_06",
    occurredOffsetDays: -23,
  },
];

// ── Notes (8) — markdown; `authorId` is mandatory ─────────

type NoteSeed = {
  id: string;
  title: string;
  pinned: boolean;
  /** Present only on the archived note; absent means "live". */
  archived?: boolean;
  projectId: string | null;
  locationId: string | null;
  tags: readonly string[];
  body: string;
};

export const NOTES: readonly NoteSeed[] = [
  {
    id: "seed_note_01",
    title: "Zugang und Sicherheitskonzept Demo-Standort",
    pinned: true,
    projectId: "seed_proj_hoersaaltechnik",
    locationId: "seed_loc_site_campus",
    tags: ["sicherheit", "verfahren"],
    body: [
      "# Zugang und Sicherheitskonzept Demo-Standort",
      "",
      "Jede:r Techniker:in braucht für Arbeiten in Technikräumen einen Schlüssel",
      "der **Demo-Gebäude-A-Serie** plus die Freischaltung im Verteiler.",
      "",
      "- Außentermine: Fahrzeugschlüssel über die Leitstelle, Rückgabe binnen 24 h.",
      "- Arbeiten am Rack: **zweite Person** im Gebäude anwesend.",
      "- Strom im Keller: ausschließlich durch autorisierte Elektrofachkräfte.",
    ].join("\n"),
  },
  {
    id: "seed_note_02",
    title: "Richtlinien Streaming und Aufzeichnung",
    pinned: true,
    projectId: "seed_proj_streaming",
    locationId: "seed_loc_virtual_hybrid",
    tags: ["streaming", "richtlinie"],
    body: [
      "# Richtlinien Streaming",
      "",
      "1. Aufzeichnungen von Lehrveranstaltungen nur nach Ankündigung.",
      "2. Bildschirmaufzeichnung und Raumkamera getrennt schalten.",
      "3. Aufzeichnungen liegen 14 Tage in `Demo-Hybrid-Instanz`.",
      "4. Keine Aufzeichnung von Prüfungen oder Sprechstunden.",
    ].join("\n"),
  },
  {
    id: "seed_note_03",
    title: "Notfall-Nummern und Eskalation",
    pinned: true,
    projectId: null,
    locationId: null,
    tags: ["notfall"],
    body: [
      "# Eskalation",
      "",
      "1. **Leitstelle AV** – interne Kurzwahl",
      "2. **Leitung Technik** – danach Hausmeister",
      "3. **Notruf** – bei Brand, Wasser oder Personenschaden **zuerst** 112",
      "",
      "> Stromausfall im Veranstaltungsbetrieb: Notstromautomatik prüfen, danach Demo-Rack 1.",
    ].join("\n"),
  },
  {
    id: "seed_note_04",
    title: "Lager-Konventionen Demo-Lager",
    pinned: false,
    projectId: "seed_proj_logistik",
    locationId: "seed_loc_storage_avlager",
    tags: ["lager", "konvention"],
    body: [
      "# Lager-Konventionen",
      "",
      "- Jedes Regal hat ein **Fach-Label** `DEMO-RACK-1-F03`.",
      "- Kleinteile liegen in Boxen mit Bezug, nie lose.",
      "- Reparaturteile wandern nach 90 Tagen ins Regal `RET-ALT`.",
      "- Der Etikettendrucker hat **Ersatzrollen** — Ersatz im Fach F01.",
    ].join("\n"),
  },
  {
    id: "seed_note_05",
    title: "Checkliste Technik-Rider",
    pinned: false,
    projectId: "seed_proj_veranstaltung",
    locationId: null,
    tags: ["rider", "checkliste"],
    body: [
      "# Rider-Checkliste",
      "",
      "- [ ] Bühne: Traversen, Winden, Lasten geprüft",
      "- [ ] Ton: Ringe ausgemessen, Systeme eingeflogen",
      "- [ ] Bild: Auflösung und Anschlüsse der Quelle prüfen",
      "- [ ] Strom: Anschlussleistungen abgleichen",
      "- [ ] Personal: Zeitenplan und Ablösung schriftlich",
      "- [ ] Rückbau: Abbau in der Rückbauquote eintragen",
    ].join("\n"),
  },
  {
    id: "seed_note_06",
    title: "Standorte und Zuständigkeiten",
    pinned: false,
    projectId: "seed_proj_logistik",
    locationId: "seed_loc_site_campus",
    tags: ["orte", "übersicht"],
    body: [
      "# Standorte",
      "",
      "| Ort | Art | Zuständig |",
      "|---|---|---|",
      "| Demo-Lager | Lager | Logistik |",
      "| Demo-Rack 1 | Patchfeld | Netzwerk |",
      "| Demo-Transporter | Fahrzeug | Außendienst |",
      "| Demo-Verleihstandort | extern | Einkauf |",
      "| Demo-Hybrid-Instanz | virtuell | Streaming |",
      "",
      "## Übergaben für die Woche",
      "",
      "- [x] Schlüsselverwaltung Demo-Lager an Logistik",
      "- [x] Rack-Dokumentation Demo-Rack 1 an Netzwerk",
      "- [ ] Fahrzeugübergabe-Protokoll an Außendienst",
      "- [ ] Verleih-Schnittstelle Demo-Verleihstandort an Einkauf",
    ].join("\n"),
  },
  {
    id: "seed_note_07",
    title: "Feedback aus dem Demo-Betrieb",
    pinned: false,
    projectId: "seed_proj_hoersaaltechnik",
    locationId: null,
    tags: ["feedback", "umfrage"],
    body: [
      "# Rückmeldungen Demo-Zeitraum",
      "",
      "- Funkmikrofone: häufigste Reklamation (Lehrende, Publikum).",
      "- Streaming: Nachfrage vor allem in den **Grundsemestern**.",
      "- Leinwände: Reinigungsintervall auf halbjährlich verkürzen.",
      "- Viele Erstsemester kennen den Notfallweg nicht.",
    ].join("\n"),
  },
  {
    id: "seed_note_08",
    title: "Archiv: Alte AV-Dokumentation",
    pinned: false,
    projectId: null,
    locationId: null,
    tags: ["archiv"],
    archived: true,
    body: [
      "# Archiv",
      "",
      "Übernommen aus der früheren Übersichtsliste. **Keine** verbindlichen",
      "Angaben — siehe stattdessen die aktuelle Betriebsdokumentation.",
      "",
      "- alte Raumliste (Stand 2019)",
      "- Ersatzteilliste ohne Bestandsführung",
    ].join("\n"),
  },
];

// ── Time entries (6) — all inside the CURRENT Berlin ISO week so the demo's
// „Zeiterfassung" is never empty no matter which weekday the seed runs on.
// seed_time_01/02 are the deliberate overlap pair (overlap is allowed — the
// week total dedupes it via `unionMinutes`).

type TimeEntrySeed = {
  id: string;
  taskId: string | null;
  userId: string;
  /** ISO weekday of the current week, 0 = Monday … 6 = Sunday. */
  weekday: number;
  startHour: number;
  endHour: number;
  comment: string;
};

export const TIME_ENTRIES: readonly TimeEntrySeed[] = [
  {
    id: "seed_time_01",
    taskId: "seed_task_lg_05",
    userId: DEMO_USER.id,
    weekday: 0,
    startHour: 9,
    endHour: 11,
    comment: "Inventurdifferenz: Kabelposten nachgezählt",
  },
  {
    id: "seed_time_02",
    taskId: "seed_task_hs_08",
    userId: DEMO_USER.id,
    weekday: 0,
    startHour: 10,
    endHour: 12,
    comment: "Ersatzbeamer A.05 getestet (parallel zur Inventur)",
  },
  {
    id: "seed_time_03",
    taskId: "seed_task_vs_05",
    userId: DEMO_USER_MK.id,
    weekday: 1,
    startHour: 13,
    endHour: 16,
    comment: "Notfallkoffer gepackt und Liste aktualisiert",
  },
  {
    id: "seed_time_04",
    taskId: "seed_task_vs_02",
    userId: DEMO_USER_JS.id,
    weekday: 2,
    startHour: 9,
    endHour: 10,
    comment: "Technik-Rider Mathe-Tage: Entwurf",
  },
  {
    id: "seed_time_05",
    taskId: "seed_task_vs_06",
    userId: DEMO_USER.id,
    weekday: 3,
    startHour: 14,
    endHour: 15,
    comment: "Beschallungsplan Demo-Foyer — Ortstermin",
  },
  {
    id: "seed_time_06",
    taskId: "seed_task_st_01",
    userId: DEMO_USER_MK.id,
    weekday: 4,
    startHour: 8,
    endHour: 10,
    comment: "Encoder-Evaluation: Datenblätter verglichen",
  },
];

// ── Inventory (31) ───────────────────────────────────────────────────────────

type StockSeed = {
  id: string;
  name: string;
  sku: string;
  serial?: string;
  quantity: number;
  unit: string;
  category: string;
  status: StockStatus;
  vendorId: string | null;
  locationId: string | null;
  purchaseOffsetDays: number | null;
  priceEuro: string | null;
  warrantyOffsetDays: number | null;
  tags: readonly string[];
};

function stock(
  n: number,
  name: string,
  sku: string,
  quantity: number,
  unit: string,
  category: string,
  status: StockStatus,
  vendorId: string | null,
  locationId: string | null,
  tags: readonly string[],
  extra: Partial<
    Pick<StockSeed, "serial" | "purchaseOffsetDays" | "priceEuro" | "warrantyOffsetDays">
  > = {},
): StockSeed {
  return {
    id: `seed_inv_${String(n).padStart(2, "0")}`,
    name,
    sku,
    quantity,
    unit,
    category,
    status,
    vendorId,
    locationId,
    tags,
    purchaseOffsetDays: null,
    priceEuro: null,
    warrantyOffsetDays: null,
    ...extra,
  };
}

export const INVENTORY: readonly StockSeed[] = [
  stock(
    1,
    "HDMI-Kabel 5m",
    "CAB-HDMI-5",
    24,
    "Stück",
    "Kabel",
    "AVAILABLE",
    "seed_vendor_buero",
    "seed_loc_storage_avlager",
    ["kabel", "hdmi"],
  ),
  stock(
    2,
    "HDMI-Kabel 10m",
    "CAB-HDMI-10",
    12,
    "Stück",
    "Kabel",
    "AVAILABLE",
    "seed_vendor_buero",
    "seed_loc_storage_avlager",
    ["kabel", "hdmi"],
  ),
  stock(
    3,
    "CAT6-Patchkabel 2m",
    "CAB-CAT6-2",
    40,
    "Stück",
    "Kabel",
    "AVAILABLE",
    "seed_vendor_buero",
    "seed_loc_rack_demo_1",
    ["kabel", "netzwerk"],
  ),
  stock(
    4,
    "LC-Doppelstecker Multimode",
    "CAB-LC-MM",
    30,
    "Stück",
    "Kabel",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_rack_demo_1",
    ["fiber"],
  ),
  stock(
    5,
    "HDMI-Verteiler 1:8",
    "SIG-HDMI-18",
    3,
    "Stück",
    "Signaltechnik",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_storage_avlager",
    ["splitter"],
    {
      serial: "SN-HD18-0031",
      purchaseOffsetDays: -300,
      priceEuro: "189.00",
      warrantyOffsetDays: 430,
    },
  ),
  stock(
    6,
    "Matrix-Switch 8x8",
    "SIG-MX-88",
    1,
    "Stück",
    "Signaltechnik",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_rack_demo_1",
    ["matrix"],
    {
      serial: "SN-MX88-0007",
      purchaseOffsetDays: -520,
      priceEuro: "1249.00",
      warrantyOffsetDays: 210,
    },
  ),
  stock(
    7,
    "SDI-Kabel BNC 3m",
    "CAB-SDI-3",
    16,
    "Stück",
    "Kabel",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_storage_avlager",
    ["kabel", "sdi"],
  ),
  stock(
    8,
    "Funkmikrofon Handsender",
    "MIK-UE-HS",
    8,
    "Stück",
    "Mikrofonie",
    "ON_LOAN",
    "seed_vendor_demo_rental",
    "seed_loc_storage_avlager",
    ["funk"],
    {
      serial: "SN-UE-2201",
      purchaseOffsetDays: -180,
      priceEuro: "149.50",
      warrantyOffsetDays: 550,
    },
  ),
  stock(
    9,
    "Funkmikrofon Sender",
    "MIK-UE-SM",
    8,
    "Stück",
    "Mikrofonie",
    "REQUESTED",
    "seed_vendor_demo_rental",
    "seed_loc_storage_avlager",
    ["funk"],
    {
      serial: "SN-UE-2202",
      purchaseOffsetDays: -180,
      priceEuro: "149.50",
      warrantyOffsetDays: 550,
    },
  ),
  stock(
    10,
    "Ansteckmikrofon",
    "MIK-LV-TS",
    4,
    "Stück",
    "Mikrofonie",
    "AVAILABLE",
    "seed_vendor_demo_rental",
    "seed_loc_storage_avlager",
    ["funk"],
  ),
  stock(
    11,
    "Schwanenhals-Mikrofon",
    "MIK-GN-SN",
    10,
    "Stück",
    "Mikrofonie",
    "AVAILABLE",
    "seed_vendor_demo_rental",
    "seed_loc_storage_avlager",
    ["konferenz"],
  ),
  stock(
    12,
    "Mischpult 8-Kanal",
    "SIG-MX-8CH",
    2,
    "Stück",
    "Signaltechnik",
    "AVAILABLE",
    "seed_vendor_demo_rental",
    "seed_loc_storage_avlager",
    ["mischpult"],
    {
      serial: "SN-MX8-1102",
      purchaseOffsetDays: -400,
      priceEuro: "890.00",
      warrantyOffsetDays: 330,
    },
  ),
  stock(
    13,
    "Lautsprecher Aktiv 2-Wege",
    "LSP-AKT-2W",
    6,
    "Stück",
    "Beschallung",
    "AVAILABLE",
    "seed_vendor_demo_rental",
    "seed_loc_storage_avlager",
    ["lautsprecher"],
    { priceEuro: "399.00", warrantyOffsetDays: 700 },
  ),
  stock(
    14,
    "Subwoofer",
    "LSP-SUB-18",
    2,
    "Stück",
    "Beschallung",
    "AWAITING_CONFIRMATION",
    "seed_vendor_demo_rental",
    "seed_loc_storage_avlager",
    ["beschallung"],
  ),
  stock(
    15,
    "Druckflaschensender",
    "MIK-UE-SB",
    0,
    "Stück",
    "Mikrofonie",
    "AVAILABLE",
    "seed_vendor_demo_rental",
    "seed_loc_storage_avlager",
    ["funk", "bestellen"],
  ),
  stock(
    16,
    "Netzwerk-Switch 24-Port",
    "NET-SW-24P",
    2,
    "Stück",
    "Netzwerk",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_rack_demo_1",
    ["netzwerk"],
    {
      serial: "SN-SW24-0410",
      purchaseOffsetDays: -600,
      priceEuro: "619.00",
      warrantyOffsetDays: 130,
    },
  ),
  stock(
    17,
    "Patchfeld 24-Port",
    "NET-PT-24P",
    1,
    "Stück",
    "Netzwerk",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_rack_demo_1",
    ["netzwerk"],
  ),
  stock(
    18,
    "SFP-Modul 1G",
    "NET-SFP-1G",
    8,
    "Stück",
    "Netzwerk",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_rack_demo_1",
    ["fiber"],
  ),
  stock(
    19,
    "Beamer-Halterung Universal",
    "MNT-BPJ-UNI",
    14,
    "Stück",
    "Montage",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_storage_avlager",
    ["montage"],
    { priceEuro: "74.90" },
  ),
  stock(
    20,
    "Leinwand 4:3",
    "SCR-43-240",
    4,
    "Stück",
    "Vorführung",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_storage_avlager",
    ["leinwand"],
  ),
  stock(
    21,
    "Leinwand 16:9",
    "SCR-169-300",
    5,
    "Stück",
    "Vorführung",
    "RESERVED_FOR_EVENT",
    "seed_vendor_demo_parts",
    "seed_loc_storage_avlager",
    ["leinwand"],
  ),
  stock(
    22,
    "Beamer-Lampe",
    "RPL-BPJ-LAMP",
    10,
    "Stück",
    "Ersatzteil",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_storage_avlager",
    ["ersatzteil"],
  ),
  stock(
    23,
    "Fernbedienung",
    "ACC-FB-GEN",
    11,
    "Stück",
    "Zubehör",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_storage_avlager",
    ["zubehör"],
  ),
  stock(
    24,
    "HDMI-Adapter USB-C",
    "CAB-HDMI-USBC",
    9,
    "Stück",
    "Kabel",
    "AVAILABLE",
    "seed_vendor_buero",
    "seed_loc_storage_avlager",
    ["adapter"],
  ),
  stock(
    25,
    "Stromverteiler 16A",
    "PWR-DIST-16A",
    6,
    "Stück",
    "Elektrik",
    "AVAILABLE",
    "seed_vendor_buero",
    "seed_loc_storage_avlager",
    ["strom"],
  ),
  stock(
    26,
    "Kabelmarker-Set",
    "ACC-MARK-SET",
    20,
    "Set",
    "Zubehör",
    "AVAILABLE",
    "seed_vendor_buero",
    "seed_loc_storage_avlager",
    ["kennzeichnung"],
  ),
  stock(
    27,
    "Gehäuse für Transport",
    "ACC-CASE-01",
    7,
    "Stück",
    "Zubehör",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_vehicle_demo_kfz1",
    ["transport"],
  ),
  stock(
    28,
    "Warnweste (Set 5)",
    "PWR-VEST-05",
    4,
    "Set",
    "Elektrik",
    "AVAILABLE",
    "seed_vendor_buero",
    "seed_loc_vehicle_demo_kfz1",
    ["sicherheit"],
  ),
  stock(
    29,
    "Kabeltrommel 25m",
    "ACC-REEL-25",
    5,
    "Stück",
    "Zubehör",
    "AVAILABLE",
    "seed_vendor_buero",
    "seed_loc_vehicle_demo_kfz1",
    ["transport"],
  ),
  stock(
    30,
    "Ersatznetzteil Beamer",
    "RPL-BPJ-PSU",
    0,
    "Stück",
    "Ersatzteil",
    "AVAILABLE",
    "seed_vendor_demo_parts",
    "seed_loc_storage_avlager",
    ["ersatzteil", "bestellen"],
  ),
  // Unassigned (locationId: null) — keeps the hideUnassigned filter demonstrable.
  stock(
    31,
    "Presenter mit Laserpointer",
    "ACC-PRES-LP",
    6,
    "Stück",
    "Zubehör",
    "AVAILABLE",
    "seed_vendor_buero",
    null,
    ["wareneingang"],
    { purchaseOffsetDays: -2, priceEuro: "39.90" },
  ),
];

// ── The self-check: literal counts vs. the data actually here ─────────────────

export type CountKey = keyof typeof EXPECTED_COUNTS;

const ACTUAL_COUNTS: Record<CountKey, number> = {
  room: ROOMS.length,
  equipmentModel: EQUIPMENT_MODELS.length,
  equipment: EQUIPMENT.length,
  event: EVENTS.length,
  eventRoomBooking: EVENT_ROOM_BOOKINGS.length,
  location: LOCATIONS.length,
  project: PROJECTS.length,
  task: TASKS.length,
  taskDependency: TASK_DEPENDENCIES.length,
  taskAssignees: TASK_ASSIGNEES.length,
  ticket: TICKETS.length,
  note: NOTES.length,
  inventoryItem: INVENTORY.length,
  vendor: VENDORS.length,
  timeEntry: TIME_ENTRIES.length,
};

/**
 * Fail loudly when the data drifts away from `EXPECTED_COUNTS`.
 *
 * Without this, editing the arrays would silently move the seed away from
 * the expected counts while every test stayed green — the seed would
 * still assert "6 projects", just of a different 6. This is the same discipline
 * as `guards.sh --self-test`: a check nobody has watched fire is a comment.
 */
export function assertCountsMatchSpec(): void {
  const drift = (Object.keys(EXPECTED_COUNTS) as CountKey[]).filter(
    (key) => EXPECTED_COUNTS[key] !== ACTUAL_COUNTS[key],
  );
  if (drift.length > 0) {
    const detail = drift
      .map((k) => `${k}: expected ${EXPECTED_COUNTS[k]}, data has ${ACTUAL_COUNTS[k]}`)
      .join("; ");
    throw new Error(
      `seed data drifted from its published counts (${detail}). ` +
        "Fix the data or update EXPECTED_COUNTS deliberately — never let them diverge silently.",
    );
  }
}

/** Every id this seed owns, across every model it writes. */
export const ALL_SEED_IDS: readonly string[] = [
  ...ROOMS.map((r) => r.id),
  ...EQUIPMENT_MODELS.map((r) => r.id),
  ...EQUIPMENT.map((r) => r.id),
  ...EVENTS.map((r) => r.id),
  ...EVENT_ROOM_BOOKINGS.map((r) => r.id),
  ...DEMO_TEAM.map((r) => r.id),
  ...LOCATIONS.map((r) => r.id),
  ...VENDORS.map((r) => r.id),
  ...PROJECTS.map((r) => r.id),
  ...TASKS.map((r) => r.id),
  ...TICKETS.map((r) => r.id),
  ...NOTES.map((r) => r.id),
  ...INVENTORY.map((r) => r.id),
  ...TIME_ENTRIES.map((r) => r.id),
];

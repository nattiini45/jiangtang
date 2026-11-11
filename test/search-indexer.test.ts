import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { resetAi, setAiForTests } from "~/lib/ai/registry.server";
import { hashEmbedder, conceptEmbedder } from "./helpers/ai-fakes";
import {
  loadSource,
  listSourceVersions,
  SOURCE_TYPES,
  type SourceType,
} from "~/lib/search/sources.server";
import { prepareChunk } from "~/lib/search/chunking";
import {
  clearEmbeddingModels,
  embedPending,
  getIndexStats,
  reconcileAll,
  reindexSource,
} from "~/lib/search/indexer.server";

/**
 * The indexer end to end on the dev DB: source builders, reconcile,
 * embedding lifecycle and the tsv keyword arm. Fixtures are plain `db.create`
 * rows (no audit needed for setup); everything is namespaced by RUN and
 * deleted in afterAll, chunks included.
 */

const RUN = `indexer_${Date.now().toString(36)}`;

const ids: Partial<Record<SourceType, string>> = {};
let userId = "";
let campusId = "";
let buildingId = "";
let parentLocationId = "";

beforeAll(async () => {
  const user = await db.user.create({
    data: {
      email: `${RUN}@test.local`,
      name: `${RUN} User`,
      initials: RUN.slice(-4).toUpperCase(),
    },
  });
  userId = user.id;

  const project = await db.project.create({
    data: {
      name: `${RUN} Projekt`,
      slug: `${RUN}-projekt`,
      status: "CONFIRMED",
      description: "Audimax AV-Umbau",
      leadId: userId,
    },
  });
  ids.PROJECT = project.id;

  const parent = await db.location.create({
    data: { name: `${RUN} Campus Ost`, kind: "SITE", code: "CO" },
  });
  parentLocationId = parent.id;
  const location = await db.location.create({
    data: {
      name: `${RUN} Demo-Gebäude A`,
      kind: "BUILDING",
      code: "K",
      parentId: parent.id,
      address: "Demo-Weg 1",
      description: "Hauptgebäude",
    },
  });
  ids.LOCATION = location.id;

  const campus = await db.campus.create({ data: { name: `${RUN} Campus`, slug: `${RUN}-campus` } });
  campusId = campus.id;
  const building = await db.building.create({
    data: { name: "Demo-Gebäude A", code: "K", campusId },
  });
  buildingId = building.id;
  const room = await db.room.create({
    data: {
      name: `${RUN} Hörsaal Demo 1`,
      slug: `${RUN}-demo-a01`,
      roomNumber: "D.03.01",
      buildingId,
    },
  });
  ids.ROOM = room.id;

  const vendor = await db.vendor.create({
    data: {
      name: `${RUN} Demo-Ersatzteile GmbH`,
      contact: "Demo Kontakt",
      email: "ersatzteile@demo-ersatzteile.example",
      phone: "0000 000000",
      url: "https://demo-ersatzteile.example",
      address: "Demo-Weg 1",
    },
  });
  ids.VENDOR = vendor.id;

  const stock = await db.inventoryItem.create({
    data: {
      name: `${RUN} HDMI-Kabel 10 m`,
      sku: `CAB-${RUN}-HDMI-10`,
      serial: `SN-${RUN}-777`,
      category: "Kabel",
      status: "AVAILABLE",
      quantity: 12,
      unit: "Stück",
      tags: ["kabel", "hdmi"],
      locationId: location.id,
      vendorId: vendor.id,
    },
  });
  ids.INVENTORY_ITEM = stock.id;

  const model = await db.equipmentModel.create({
    data: { manufacturer: "Epson", name: `${RUN} EB-L1505U`, category: "PROJECTOR" },
  });
  const equipment = await db.equipment.create({
    data: {
      name: `${RUN} Beamer A.01`,
      modelId: model.id,
      roomId: room.id,
      category: "PROJECTOR",
      serial: "EB-8842-DE",
      assetTag: "INV-2024-015",
      ipAddress: "192.0.2.40",
      macAddress: "02:00:00:11:3A:B7",
      hostname: "beamer-demo-a01",
    },
  });
  ids.EQUIPMENT = equipment.id;
  eqModelId = model.id;

  const task = await db.task.create({
    data: {
      title: `${RUN} Encoder konfigurieren`,
      body: "## Aufbau\nRTMP-Ziel eintragen.",
      status: "IN_PROGRESS",
      priority: "HIGH",
      labels: ["av", "livestream"],
      projectId: project.id,
      dueAt: new Date("2026-10-14T10:00:00.000Z"),
    },
  });
  await db.taskAssignees.create({ data: { taskId: task.id, userId } });
  ids.TASK = task.id;

  const ticket = await db.ticket.create({
    data: {
      title: `${RUN} Ton fällt aus`,
      type: "INCIDENT",
      status: "OPEN",
      description: "Funkstrecke bricht ab.",
      resolution: "Kanal gewechselt.",
      priority: 1,
      roomId: room.id,
      equipmentId: equipment.id,
    },
  });
  await db.ticket.update({
    where: { id: ticket.id },
    data: { assignees: { connect: { id: userId } } },
  });
  ids.TICKET = ticket.id;

  const note = await db.note.create({
    data: {
      title: `${RUN} Checkliste Aufbau`,
      body: "## Vorher\n- Akkus laden\n\n## Nachher\n- zurück ins Lager",
      authorId: userId,
      tags: ["checkliste"],
      projectId: project.id,
    },
  });
  ids.NOTE = note.id;

  const event = await db.event.create({
    data: {
      title: `${RUN} Tag der offenen Tür`,
      description: "Technikbetreuung 8–16 Uhr.",
      startsAt: new Date("2026-11-14T07:00:00.000Z"),
      endsAt: new Date("2026-11-14T15:00:00.000Z"),
      status: "CONFIRMED",
    },
  });
  await db.eventRoomBooking.create({
    data: { eventId: event.id, roomId: room.id, startsAt: event.startsAt, endsAt: event.endsAt },
  });
  ids.EVENT = event.id;
});

let eqModelId = "";

afterAll(async () => {
  const sourceIds = Object.values(ids).filter(Boolean) as string[];
  await db.chunk.deleteMany({ where: { sourceId: { in: sourceIds } } });
  await db.searchIndexJob.deleteMany({ where: { sourceId: { in: sourceIds } } });
  for (const [type, id] of Object.entries(ids)) {
    if (!id) continue;
    const t = type as SourceType;
    await db.eventRoomBooking.deleteMany({ where: { eventId: id } }).catch(() => undefined);
    if (t === "TASK") await db.taskAssignees.deleteMany({ where: { taskId: id } });
    if (t === "TICKET")
      await db.ticket
        .update({ where: { id }, data: { assignees: { set: [] } } })
        .catch(() => undefined);
    const del: Record<SourceType, () => Promise<unknown>> = {
      TASK: () => db.task.delete({ where: { id } }),
      TICKET: () => db.ticket.delete({ where: { id } }),
      NOTE: () => db.note.delete({ where: { id } }),
      PROJECT: () => db.project.delete({ where: { id } }),
      INVENTORY_ITEM: () => db.inventoryItem.delete({ where: { id } }),
      EQUIPMENT: () => db.equipment.delete({ where: { id } }),
      EVENT: () => db.event.delete({ where: { id } }),
      LOCATION: () => db.location.delete({ where: { id } }),
      ROOM: () => db.room.delete({ where: { id } }),
      VENDOR: () => db.vendor.delete({ where: { id } }),
    };
    await del[t]().catch(() => undefined);
  }
  if (parentLocationId)
    await db.location.delete({ where: { id: parentLocationId } }).catch(() => undefined);
  if (eqModelId)
    await db.equipmentModel.delete({ where: { id: eqModelId } }).catch(() => undefined);
  if (buildingId) await db.building.delete({ where: { id: buildingId } }).catch(() => undefined);
  if (campusId) await db.campus.delete({ where: { id: campusId } }).catch(() => undefined);
  if (userId) await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  resetAi();
  await db.$disconnect();
});

afterEach(() => resetAi());

describe("listSourceVersions", () => {
  it("returns id+updatedAt for every source type", async () => {
    for (const type of SOURCE_TYPES) {
      const versions = await listSourceVersions(type);
      const hit = versions.find((v) => v.id === ids[type]);
      expect(hit, `${type} version`).toBeTruthy();
      expect(hit!.updatedAt).toBeInstanceOf(Date);
    }
  });
});

describe("loadSource — one fixture row per type", () => {
  it("TASK: meta line carries status, priority, labels, project, assignee, due date", async () => {
    const s = await loadSource("TASK", ids.TASK!);
    expect(s?.title).toBe(`${RUN} Encoder konfigurieren`);
    const meta = s!.sections[0].text;
    expect(meta).toContain("Status: In Arbeit");
    expect(meta).toContain("Priorität: Hoch");
    expect(meta).toContain("Labels: av, livestream");
    expect(meta).toContain(`Projekt: ${RUN} Projekt`);
    expect(meta).toContain("Fällig:");
    // body chunk carries the heading trail
    expect(s!.sections.some((x) => x.headingPath.includes("Aufbau"))).toBe(true);
  });

  it("TICKET: type + status + room + equipment + assignee", async () => {
    const s = await loadSource("TICKET", ids.TICKET!);
    const meta = s!.sections[0].text;
    expect(meta).toContain("Typ: Störung");
    expect(meta).toContain("Status: Offen");
    expect(meta).toContain("Raum: D.03.01");
    expect(meta).toContain("Gerät: Epson");
    expect(meta).toContain("Zuständig:");
    const all = s!.sections.map((x) => x.text).join("\n");
    expect(all).toContain("Funkstrecke bricht ab.");
    expect(all).toContain("Lösung: Kanal gewechselt.");
  });

  it("NOTE: tags + project, body chunked; archived notes are indexed too", async () => {
    const s = await loadSource("NOTE", ids.NOTE!);
    expect(s?.sections[0].text).toContain("Tags: checkliste");
    expect(s?.sections[0].text).toContain(`Projekt: ${RUN} Projekt`);
    expect(s!.sections.some((x) => x.headingPath.includes("Vorher"))).toBe(true);
    // archive it — still loadable/indexable
    await db.note.update({ where: { id: ids.NOTE! }, data: { archivedAt: new Date() } });
    const archived = await loadSource("NOTE", ids.NOTE!);
    expect(archived?.sections[0].text).toContain("Archiviert");
    await db.note.update({ where: { id: ids.NOTE! }, data: { archivedAt: null } });
  });

  it("PROJECT: status + lead", async () => {
    const s = await loadSource("PROJECT", ids.PROJECT!);
    expect(s?.title).toBe(`${RUN} Projekt`);
    expect(s?.sections[0].text).toContain("Status: Bestätigt");
    expect(s?.sections[0].text).toContain("Leitung:");
  });

  it("INVENTORY_ITEM: sku, serial, location path, vendor", async () => {
    const s = await loadSource("INVENTORY_ITEM", ids.INVENTORY_ITEM!);
    const meta = s!.sections[0].text;
    expect(meta).toContain(`SKU: CAB-${RUN}-HDMI-10`);
    expect(meta).toContain(`Seriennummer: SN-${RUN}-777`);
    expect(meta).toContain("Verfügbar");
    expect(meta).toContain("Bestand: 12 Stück");
    expect(meta).toContain(`${RUN} Campus Ost (CO) / ${RUN} Demo-Gebäude A (K)`);
    expect(meta).toContain("Lieferant:");
  });

  it("EQUIPMENT: model, serial, asset tag, IP/MAC/hostname, room", async () => {
    const s = await loadSource("EQUIPMENT", ids.EQUIPMENT!);
    expect(s?.title).toContain("EB-L1505U");
    const meta = s!.sections[0].text;
    expect(meta).toContain("Kategorie: Projektor");
    expect(meta).toContain("Seriennummer: EB-8842-DE");
    expect(meta).toContain("Inventarnummer: INV-2024-015");
    expect(meta).toContain("IP: 192.0.2.40");
    expect(meta).toContain("MAC: 02:00:00:11:3A:B7");
    expect(meta).toContain("Hostname: beamer-demo-a01");
    expect(meta).toContain("Raum: D.03.01");
  });

  it("EVENT: rooms and Berlin time", async () => {
    const s = await loadSource("EVENT", ids.EVENT!);
    const meta = s!.sections[0].text;
    expect(meta).toContain("Bestätigt");
    expect(meta).toContain("Räume: D.03.01");
    expect(meta).toMatch(/Zeit:.*14\.11\.2026/);
  });

  it("LOCATION: kind, code, address, parent path", async () => {
    const s = await loadSource("LOCATION", ids.LOCATION!);
    const meta = s!.sections[0].text;
    expect(meta).toContain("Typ: Gebäude");
    expect(meta).toContain("Code: K");
    expect(meta).toContain("Demo-Weg 1");
    expect(meta).toContain(`${RUN} Campus Ost`);
  });

  it("ROOM: number + building", async () => {
    const s = await loadSource("ROOM", ids.ROOM!);
    expect(s?.title).toContain("D.03.01");
    expect(s?.sections[0].text).toContain("Raumnummer: D.03.01");
    expect(s?.sections[0].text).toContain("Gebäude: Demo-Gebäude A");
  });

  it("VENDOR: contact fields", async () => {
    const s = await loadSource("VENDOR", ids.VENDOR!);
    const meta = s!.sections[0].text;
    expect(meta).toContain("Ansprechpartner: Demo Kontakt");
    expect(meta).toContain("ersatzteile@demo-ersatzteile.example");
    expect(meta).toContain("0000 000000");
  });

  it("a missing id resolves to null (delete path)", async () => {
    expect(await loadSource("TASK", `${RUN}-nope`)).toBeNull();
  });
});

describe("loadSource — meta lines follow DEFAULT_LOCALE", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("en: English labels and field names", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "en");
    const task = (await loadSource("TASK", ids.TASK!))!.sections[0].text;
    expect(task).toContain("Status: In progress");
    expect(task).toContain("Priority: High");
    expect(task).toContain(`Project: ${RUN} Projekt`);
    expect(task).toContain("Assigned to:");
    expect(task).toContain("Due:");
    expect(task).not.toMatch(/Priorität|Projekt:|Zuständig|Fällig/);

    const ticket = (await loadSource("TICKET", ids.TICKET!))!;
    const meta = ticket.sections[0].text;
    expect(meta).toContain("Type: Incident");
    expect(meta).toContain("Status: Open");
    expect(meta).toContain("Room: D.03.01");
    expect(meta).toContain("Equipment: Epson");
    expect(ticket.sections.map((x) => x.text).join("\n")).toContain(
      "Resolution: Kanal gewechselt.",
    );

    expect((await loadSource("EQUIPMENT", ids.EQUIPMENT!))!.sections[0].text).toContain(
      "Category: Projector",
    );
    expect((await loadSource("EQUIPMENT", ids.EQUIPMENT!))!.sections[0].text).toContain(
      "Asset tag: INV-2024-015",
    );
    expect((await loadSource("LOCATION", ids.LOCATION!))!.sections[0].text).toContain(
      "Type: Building",
    );
    expect((await loadSource("ROOM", ids.ROOM!))!.sections[0].text).toContain(
      "Room number: D.03.01",
    );
    expect((await loadSource("VENDOR", ids.VENDOR!))!.sections[0].text).toContain(
      "Contact: Demo Kontakt",
    );
    expect((await loadSource("EVENT", ids.EVENT!))!.sections[0].text).toMatch(/Time:.*14 Nov 2026/);
  });

  it("de: unchanged German labels", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    const ticket = (await loadSource("TICKET", ids.TICKET!))!.sections[0].text;
    expect(ticket).toContain("Typ: Störung");
    expect(ticket).toContain("Zuständig:");
  });
});

describe("reindexSource + reconcileAll", () => {
  it("is idempotent — a second run touches no row's updatedAt", async () => {
    await reindexSource("TASK", ids.TASK!);
    const first = await db.chunk.findMany({ where: { sourceType: "TASK", sourceId: ids.TASK! } });
    expect(first.length).toBeGreaterThan(0);
    await reindexSource("TASK", ids.TASK!);
    const second = await db.chunk.findMany({ where: { sourceType: "TASK", sourceId: ids.TASK! } });
    expect(second.map((c) => c.updatedAt.getTime())).toEqual(
      first.map((c) => c.updatedAt.getTime()),
    );
  });

  it(
    "a task edit makes the index stale; reconcileAll reindexes it",
    { timeout: 120_000 },
    async () => {
      await reindexSource("TASK", ids.TASK!);
      const stale0 = (await db.chunk.findFirst({
        where: { sourceType: "TASK", sourceId: ids.TASK!, ordinal: 0 },
      }))!.updatedAt;
      await new Promise((r) => setTimeout(r, 1100)); // beat the 1 ms updatedAt granularity
      await db.task.update({ where: { id: ids.TASK! }, data: { title: `${RUN} Encoder neu` } });
      await reconcileAll();
      const chunks = await db.chunk.findMany({
        where: { sourceType: "TASK", sourceId: ids.TASK! },
      });
      expect(chunks.every((c) => c.sourceTitle === `${RUN} Encoder neu`)).toBe(true);
      expect(chunks[0]!.updatedAt.getTime()).toBeGreaterThan(stale0.getTime());
    },
  );

  it("deleting a source deletes its chunks and jobs", async () => {
    await reindexSource("NOTE", ids.NOTE!);
    expect(
      await db.chunk.count({ where: { sourceType: "NOTE", sourceId: ids.NOTE! } }),
    ).toBeGreaterThan(0);
    await db.note.delete({ where: { id: ids.NOTE! } });
    await reindexSource("NOTE", ids.NOTE!); // loadSource → null → purge
    expect(await db.chunk.count({ where: { sourceType: "NOTE", sourceId: ids.NOTE! } })).toBe(0);
    // recreate for the later suites
    const note = await db.note.create({
      data: {
        title: `${RUN} Checkliste Aufbau`,
        body: "## Vorher\n- Akkus laden",
        authorId: userId,
        tags: ["checkliste"],
        projectId: ids.PROJECT,
      },
    });
    ids.NOTE = note.id;
  });
});

describe("foreign source types", () => {
  it(
    "are never touched: not reindexed, not orphaned, not embedded, not cleared",
    { timeout: 120_000 },
    async () => {
      const FOREIGN = `${RUN}-FOREIGN`;
      const foreignId = `${RUN}-ext-1`;
      const prepared = prepareChunk({
        sourceType: FOREIGN,
        sourceId: foreignId,
        sourceTitle: "extern",
        ordinal: 0,
        headingPath: [],
        text: "fremder Inhalt",
        sourceUpdatedAt: new Date(),
      });
      const row = await db.chunk.create({ data: prepared });
      try {
        // An unknown type is not an orphan — a direct reindex is a no-op.
        await reindexSource(FOREIGN as SourceType, foreignId);
        expect(await db.chunk.count({ where: { sourceType: FOREIGN } })).toBe(1);

        await reconcileAll();
        expect(await db.chunk.count({ where: { sourceType: FOREIGN } })).toBe(1);

        setAiForTests({ embedding: hashEmbedder });
        let guard = 0;
        while ((await embedPending({ limit: 10_000 })).embedded > 0 && guard++ < 10) {
          /* drain */
        }
        const foreign = await db.chunk.findUniqueOrThrow({ where: { id: row.id } });
        expect(foreign.embeddingModel).toBeNull();
        expect(await db.searchIndexJob.count({ where: { sourceType: FOREIGN } })).toBe(0);

        // Re-embed sweeps are scoped to the known types too.
        await db.$executeRaw`UPDATE "Chunk" SET "embeddingModel" = 'foreign-model' WHERE id = ${row.id}`;
        await db.chunk.updateMany({
          where: { sourceType: "NOTE" },
          data: { updatedAt: new Date("2000-01-01T00:00:00Z") },
        });
        await clearEmbeddingModels();
        expect((await getIndexStats()).overdueEmbeddings).toBe(0);
        expect((await db.chunk.findUniqueOrThrow({ where: { id: row.id } })).embeddingModel).toBe(
          "foreign-model",
        );
        expect(
          await db.chunk.count({ where: { sourceType: "NOTE", embeddingModel: { not: null } } }),
        ).toBe(0);
      } finally {
        await db.chunk.deleteMany({ where: { sourceType: FOREIGN } });
        await db.searchIndexJob.deleteMany({ where: { sourceType: FOREIGN } });
      }
    },
  );
});

describe("embedPending", () => {
  it(
    "embeds pending chunks with the fake provider and stamps the model id",
    { timeout: 120_000 },
    async () => {
      await reindexSource("NOTE", ids.NOTE!);
      setAiForTests({ embedding: hashEmbedder });
      // Drain: the corpus is bigger than one batch, so loop until nothing is pending.
      let guard = 0;
      while ((await embedPending({ limit: 10_000 })).embedded > 0 && guard++ < 10) {
        /* drain */
      }
      expect(guard).toBeGreaterThan(0);
      // clean slate for the failure test: nothing pending against "fake-hash".
      await db.searchIndexJob.deleteMany({});
      const rows = await db.$queryRaw<{ embeddingModel: string | null; w: number }[]>`
      SELECT "embeddingModel", vector_dims(embedding) AS w FROM "Chunk"
      WHERE "sourceType" = 'NOTE' AND "sourceId" = ${ids.NOTE!}`;
      expect(rows.every((x) => x.embeddingModel === "fake-hash@1024")).toBe(true);
      expect(rows.every((x) => x.w === 1024)).toBe(true);
      expect((await getIndexStats()).activeModel).toBe("fake-hash@1024");
    },
  );

  it(
    "a failing provider records a job with backoff and leaves the chunk unembedded",
    { timeout: 120_000 },
    async () => {
      // Leftover jobs from an aborted run would be future-dated and block sources.
      await db.searchIndexJob.deleteMany({
        where: { lastError: { contains: "endpoint unreachable" } },
      });
      try {
        await reindexSource("VENDOR", ids.VENDOR!);
        setAiForTests({
          embedding: {
            id: "fake-broken@1024",
            dimensions: 1024,
            embed: async () => {
              throw new Error("endpoint unreachable");
            },
          },
        });
        const before = Date.now();
        const r = await embedPending({ limit: 10_000 });
        const after = Date.now();
        expect(r.embedded).toBe(0);
        const job = await db.searchIndexJob.findUnique({
          where: {
            sourceType_sourceId_op: { sourceType: "VENDOR", sourceId: ids.VENDOR!, op: "embed" },
          },
        });
        expect(job?.attempts).toBe(1);
        expect(job?.lastError).toContain("endpoint unreachable");
        // backoff = 30 s · 2^attempts = 60 s, capped at 1 h — the timestamp is set
        // when the job row is written, which can be seconds after `before` when
        // the failing batch covers the whole seeded corpus.
        expect(job!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 55_000);
        expect(job!.nextAttemptAt.getTime()).toBeLessThanOrEqual(after + 60_000);

        // Not yet due → the next run skips it entirely (attempts stays 1).
        await embedPending({ limit: 10_000 });
        const still = await db.searchIndexJob.findUnique({
          where: {
            sourceType_sourceId_op: { sourceType: "VENDOR", sourceId: ids.VENDOR!, op: "embed" },
          },
        });
        expect(still?.attempts).toBe(1);

        // Wind the clock forward: due now → attempts increments and backoff doubles.
        await db.searchIndexJob.update({
          where: {
            sourceType_sourceId_op: { sourceType: "VENDOR", sourceId: ids.VENDOR!, op: "embed" },
          },
          data: { nextAttemptAt: new Date(Date.now() - 1000) },
        });
        await embedPending({ limit: 10_000 });
        const again = await db.searchIndexJob.findUnique({
          where: {
            sourceType_sourceId_op: { sourceType: "VENDOR", sourceId: ids.VENDOR!, op: "embed" },
          },
        });
        expect(again?.attempts).toBe(2);
        expect(again!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 100_000);
      } finally {
        // The failed batch covered the whole corpus — drop the jobs it wrote so a
        // not-yet-due job can't block a later test's provider swap.
        await db.searchIndexJob.deleteMany({
          where: { lastError: { contains: "endpoint unreachable" } },
        });
      }
    },
  );

  it("a changed active model id re-embeds the chunks", { timeout: 120_000 }, async () => {
    setAiForTests({ embedding: hashEmbedder });
    await embedPending({ limit: 10_000 });
    setAiForTests({ embedding: conceptEmbedder });
    await embedPending({ limit: 10_000 });
    const rows = await db.$queryRaw<{ embeddingModel: string }[]>`
      SELECT "embeddingModel" FROM "Chunk" WHERE "sourceId" = ${ids.NOTE!}`;
    expect(rows.every((x) => x.embeddingModel === "fake-concept@1024")).toBe(true);
  });

  it("no provider → no-op, lexical rows intact", async () => {
    resetAi(); // test env has no EMBEDDING_BASE_URL → none
    const r = await embedPending({ limit: 10_000 });
    expect(r).toEqual({ embedded: 0, failedSources: 0 });
    expect(await db.chunk.count({ where: { sourceId: ids.NOTE! } })).toBeGreaterThan(0);
  });
});

describe("tsv lexical arm", () => {
  it("finds a chunk by a keyword variant only present via identifierVariants", async () => {
    await reindexSource("VENDOR", ids.VENDOR!);
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Chunk"
      WHERE "sourceType" = 'VENDOR' AND "sourceId" = ${ids.VENDOR!}
        AND tsv @@ plainto_tsquery('simple', 'ersatzteile')`;
    expect(rows.length).toBeGreaterThan(0); // ersatzteile@demo-ersatzteile.example → variant "ersatzteile"
  });
});

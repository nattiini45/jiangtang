import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { db } from "~/lib/db.server";
import { initializeEquipmentKinds } from "~/lib/equipment-kinds/kinds.server";
import library from "~/lib/equipment-kinds/library.json";
import { registerStructureTools } from "~/lib/mcp/structure-tools.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { installLibraryKinds, listKindLibrary } from "../library.server";

const actor = { name: "Synthetic library admin" };
const ids: string[] = [];
let baselineGroups: string[];
let baselineFunctions: string[];
beforeAll(async () => {
  await initializeEquipmentKinds();
  baselineGroups = (await db.equipmentFunctionGroup.findMany()).map((group) => group.id);
  baselineFunctions = (await db.roomFunction.findMany()).map((row) => row.id);
});
afterEach(async () => {
  const owned = await db.equipmentKind.findMany({
    where: { OR: [{ id: { in: ids } }, { name: { startsWith: "library-limit-" } }] },
    select: { id: true },
  });
  const links = await db.customFieldKind.findMany({
    where: { kindId: { in: owned.map((kind) => kind.id) } },
  });
  await db.customFieldKind.deleteMany({ where: { kindId: { in: owned.map((kind) => kind.id) } } });
  await db.roomFunctionKind.deleteMany({ where: { kindId: { in: owned.map((kind) => kind.id) } } });
  await db.roomFunction.deleteMany({ where: { id: { notIn: baselineFunctions } } });
  await db.customField.deleteMany({
    where: { id: { in: links.map((link) => link.fieldId) }, kinds: { none: {} } },
  });
  await db.equipmentKind.deleteMany({
    where: { OR: [{ id: { in: ids } }, { name: { startsWith: "library-limit-" } }] },
  });
  await db.equipmentFunctionGroup.deleteMany({ where: { id: { notIn: baselineGroups } } });
  ids.length = 0;
  vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());
async function install(keys: string[]) {
  const result = await installLibraryKinds(actor, { keys });
  ids.push(...result.installed.map((kind) => kind.id));
  return result.installed;
}

it("ships only the scoped bilingual data, valid names, ordered groups and five institution types", () => {
  expect(library.institutionTypes).toHaveLength(5);
  expect(library.kinds).toHaveLength(106);
  expect(library.functionGroups).toHaveLength(20);
  for (const kind of library.kinds) {
    expect(Object.keys(kind).sort()).toEqual([
      "de",
      "en",
      "group",
      "institution_types",
      "key",
      "properties",
      "tier",
    ]);
    expect(kind.de.length).toBeLessThanOrEqual(60);
    expect(kind.en.length).toBeLessThanOrEqual(60);
    expect(library.functionGroups.some((group) => group.key === kind.group)).toBe(true);
    expect(["core", "common", "special"]).toContain(kind.tier);
  }
});

it("reports ten defaults as present under the installation's names and filters by house", async () => {
  const all = await listKindLibrary();
  expect(all.kinds.filter((kind) => kind.status === "present")).toHaveLength(10);
  expect(all.kinds.find((kind) => kind.key === "computer")).toMatchObject({
    status: "present",
    installedName: "PC",
  });
  const theatre = await listKindLibrary("theatre");
  expect(theatre.kinds.length).toBeLessThan(all.kinds.length);
  expect(theatre.kinds.every((kind) => kind.institution_types.includes("theatre"))).toBe(true);
  expect(all.remaining).toBe(70);
});

it("installs kinds and missing groups atomically in library order with per-definition audits", async () => {
  const installed = await install(["avoip_decoder", "extender", "avoip_encoder"]);
  expect(installed.map((kind) => kind.systemKey)).toEqual([
    "extender",
    "avoip_encoder",
    "avoip_decoder",
  ]);
  expect(installed.map((kind) => kind.position)).toEqual([0, 1, 2]);
  const group = await db.equipmentFunctionGroup.findUniqueOrThrow({
    where: { systemKey: "transport" },
  });
  expect(group.name).toBe("Übertragung");
  expect(installed.every((kind) => kind.groupId === group.id && !kind.tracksFrequency)).toBe(true);
  expect(
    await db.activityLog.count({
      where: {
        entityId: { in: [...ids, group.id] },
        action: { in: ["EquipmentKindCreated", "EquipmentFunctionGroupCreated"] },
      },
    }),
  ).toBe(4);
});

it("uses DEFAULT_LOCALE for new names without renaming existing kinds", async () => {
  vi.stubEnv("DEFAULT_LOCALE", "en");
  const [kind] = await install(["extender"]);
  expect(kind.name).toBe("Extender");
  expect(
    (await db.equipmentFunctionGroup.findUniqueOrThrow({ where: { id: kind.groupId } })).name,
  ).toBe("Transport");
  expect(
    (await listKindLibrary()).kinds.find((kind) => kind.key === "computer")?.installedName,
  ).toBe("PC");
});

it("refuses present, archived, taken, duplicate and unknown keys without partial installation", async () => {
  const group = await db.equipmentFunctionGroup.findUniqueOrThrow({
    where: { systemKey: "display" },
  });
  const taken = await db.equipmentKind.create({
    data: { name: "DISPLAY (MONITOR)", groupId: group.id, position: 99 },
  });
  ids.push(taken.id);
  expect((await listKindLibrary()).kinds.find((kind) => kind.key === "display")?.status).toBe(
    "taken",
  );
  for (const keys of [
    ["projector", "extender"],
    ["display", "extender"],
    ["unknown", "extender"],
    ["extender", "extender"],
  ]) {
    await expect(install(keys)).rejects.toThrow();
    expect(await db.equipmentKind.findUnique({ where: { systemKey: "extender" } })).toBeNull();
    expect(
      await db.equipmentFunctionGroup.findUnique({ where: { systemKey: "transport" } }),
    ).toBeNull();
  }
  const [archived] = await install(["led_wall"]);
  await db.equipmentKind.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
  expect((await listKindLibrary()).kinds.find((kind) => kind.key === "led_wall")?.status).toBe(
    "archived",
  );
  await expect(install(["led_wall", "extender"])).rejects.toThrow();
  expect(await db.equipmentKind.findUnique({ where: { systemKey: "extender" } })).toBeNull();
});

it("refuses a conflict introduced after listing, names it and rolls back every definition and audit", async () => {
  expect((await listKindLibrary()).kinds.find((kind) => kind.key === "display")?.status).toBe(
    "available",
  );
  const group = await db.equipmentFunctionGroup.findUniqueOrThrow({
    where: { systemKey: "display" },
  });
  const taken = await db.equipmentKind.create({
    data: { name: "Display (Monitor)", groupId: group.id, position: 99 },
  });
  ids.push(taken.id);
  const before = await db.activityLog.count();
  await expect(install(["extender", "display"])).rejects.toMatchObject({
    fieldErrors: { keys: [expect.stringContaining("Display (Monitor)")] },
  });
  expect(await db.activityLog.count()).toBe(before);
  expect(
    await db.equipmentFunctionGroup.findUnique({ where: { systemKey: "transport" } }),
  ).toBeNull();
});

it("checks capacity and rolls back a later group-name conflict", async () => {
  const group = await db.equipmentFunctionGroup.findUniqueOrThrow({
    where: { systemKey: "display" },
  });
  const active = await db.equipmentKind.count({ where: { archivedAt: null } });
  await db.equipmentKind.createMany({
    data: Array.from({ length: 80 - active }, (_, i) => ({
      name: `library-limit-${i}`,
      groupId: group.id,
      position: i,
    })),
  });
  await expect(install(["extender"])).rejects.toThrow();
  await db.equipmentKind.deleteMany({ where: { name: { startsWith: "library-limit-" } } });
  await db.equipmentFunctionGroup.create({ data: { name: "Übertragung", position: 99 } });
  const before = await db.activityLog.count();
  await expect(install(["display", "extender"])).rejects.toThrow();
  expect(await db.equipmentKind.findUnique({ where: { systemKey: "display" } })).toBeNull();
  expect(await db.activityLog.count()).toBe(before);
});

it("lists and installs through the real SDK and refuses non-admin and read-only tokens", async () => {
  const user = await db.user.findFirstOrThrow();
  const context: McpContext = {
    user: { id: user.id, name: user.name, email: user.email, initials: null, role: "ADMIN" },
    token: { id: "synthetic", name: "Synthetic", scope: "READ_WRITE" },
  };
  const server = new McpServer({ name: "library-test", version: "1" });
  registerStructureTools(server, context);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const listed = await client.callTool({
      name: "list_kind_library",
      arguments: { institutionType: "university" },
    });
    expect(listed.isError).not.toBe(true);
    const installed = await client.callTool({
      name: "install_library_kinds",
      arguments: { keys: ["extender", "avoip_encoder"] },
    });
    expect(installed.isError).not.toBe(true);
    ids.push(
      ...(
        installed.structuredContent as { result: { installed: { id: string }[] } }
      ).result.installed.map((kind) => kind.id),
    );
    context.token.scope = "READ_ONLY";
    expect(
      (await client.callTool({ name: "install_library_kinds", arguments: { keys: ["display"] } }))
        .isError,
    ).toBe(true);
    context.user.role = "MEMBER";
    expect((await client.callTool({ name: "list_kind_library", arguments: {} })).isError).toBe(
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

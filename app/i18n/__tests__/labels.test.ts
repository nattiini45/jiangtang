import { describe, expect, it } from "vitest";
import { roleLabel } from "~/components/auth/labels";
import { entityTypeLabel } from "~/components/history/labels";
import { LOCATION_KINDS, kindLabel } from "~/components/locations/labels";
import { laneTitle } from "~/components/tasks/labels";
import { stockCreateSchema } from "~/domains/inventory/inventory.stock.schema";
import { taskCsvRowSchema } from "~/domains/tasks/tasks.schema";
import { StockStatus, TaskPriority, TaskStatus } from "~/generated/prisma/enums";
import { armLabel, sourceTypeLabel } from "~/lib/search/labels";
import {
  STOCK_STATUS_ALIASES,
  TASK_PRIORITY_ALIASES,
  statusLabel,
  statusToken,
  stockStatusLabel,
  taskPriorityLabel,
  taskStatusLabel,
} from "~/lib/status";

describe("status labels follow the locale", () => {
  it("localizes every kind of status badge but keeps the tone", () => {
    expect(statusToken("de", "ticket", "IN_PROGRESS")).toMatchObject({
      label: "In Arbeit",
      tone: "warning",
    });
    expect(statusToken("en", "ticket", "IN_PROGRESS")).toMatchObject({
      label: "In progress",
      tone: "warning",
    });
    expect(statusLabel("en", "room", "TECH_DEFECT")).toBe("Technical fault");
    expect(statusLabel("de", "room", "TECH_DEFECT")).toBe("Technikdefekt");
    expect(statusLabel("en", "event", "DONE")).toBe("Completed");
    expect(statusLabel("en", "equipment", "FAULTY")).toBe("Faulty");
    expect(statusLabel("en", "project", "FOLLOW_UP_REQUIRED")).toBe("Follow-up required");
  });

  it("falls back to the raw value for an unknown status", () => {
    expect(statusLabel("en", "room", "MYSTERY" as never)).toBe("MYSTERY");
    expect(statusToken("en", "room", "MYSTERY" as never).tone).toBe("neutral");
  });

  it("localizes task status and priority", () => {
    expect(taskStatusLabel("en", "TODO")).toBe("To do");
    expect(taskStatusLabel("de", "TODO")).toBe("Offen");
    expect(taskPriorityLabel("en", "URGENT")).toBe("Urgent");
    expect(taskPriorityLabel("de", "URGENT")).toBe("Dringend");
  });

  it("localizes roles, entity types, location kinds, lanes and search labels", () => {
    expect(roleLabel("de", "MEMBER")).toBe("Mitglied");
    expect(roleLabel("en", "MEMBER")).toBe("Member");
    expect(entityTypeLabel("en", "equipmentAllocation")).toBe("Equipment allocation");
    expect(entityTypeLabel("de", "equipmentAllocation")).toBe("Gerätezuteilung");
    expect(entityTypeLabel("en", "somethingNew")).toBe("somethingNew");
    expect(kindLabel("en", "VEHICLE")).toBe("Vehicle");
    expect(kindLabel("de", "VEHICLE")).toBe("Fahrzeug");
    expect(kindLabel("en", "UNKNOWN")).toBe("UNKNOWN");
    expect(laneTitle("en", "IN_REVIEW")).toBe("Review / Blocked");
    expect(laneTitle("de", "IN_REVIEW")).toBe("Review / Blockiert");
    expect(sourceTypeLabel("en", "INVENTORY_ITEM")).toBe("Stock item");
    expect(sourceTypeLabel("de", "INVENTORY_ITEM")).toBe("Lagerartikel");
    expect(armLabel("en", "dense")).toBe("semantic");
    expect(armLabel("de", "dense")).toBe("semantisch");
    expect(armLabel("de", "other")).toBe("other");
  });

  it("has a label for every location kind in both languages", () => {
    for (const kind of LOCATION_KINDS) {
      expect(kindLabel("de", kind)).not.toBe(kind);
      expect(kindLabel("en", kind)).not.toBe(kind);
    }
  });
});

describe("CSV label grammar", () => {
  it("resolves enum value, German label and English label, case-insensitively", () => {
    for (const cell of ["ON_LOAN", "on_loan", "Verliehen", "VERLIEHEN", "On loan", " on LOAN "]) {
      expect(STOCK_STATUS_ALIASES.resolve(cell), cell).toBe("ON_LOAN");
    }
    expect(STOCK_STATUS_ALIASES.resolve("Für Veranstaltung reserviert")).toBe("RESERVED_FOR_EVENT");
    expect(STOCK_STATUS_ALIASES.resolve("reserved for event")).toBe("RESERVED_FOR_EVENT");
    expect(STOCK_STATUS_ALIASES.resolve("nonsense")).toBeNull();
    expect(TASK_PRIORITY_ALIASES.resolve("niedrigste")).toBe("LOWEST");
    expect(TASK_PRIORITY_ALIASES.resolve("Lowest")).toBe("LOWEST");
    expect(TASK_PRIORITY_ALIASES.resolve("Low")).toBe("LOW");
  });

  it("lists the labels of one language in enum order", () => {
    expect(STOCK_STATUS_ALIASES.labels("en")).toEqual([
      "Available",
      "Requested",
      "Awaiting confirmation",
      "On loan",
      "Reserved for event",
    ]);
    expect(STOCK_STATUS_ALIASES.labels("de")).toContain("Wartet auf Bestätigung");
  });

  it("stock import accepts every status spelling whatever the UI language", () => {
    for (const status of Object.values(StockStatus)) {
      for (const locale of ["de", "en"] as const) {
        const parsed = stockCreateSchema.parse({
          name: "a",
          status: stockStatusLabel(locale, status),
        });
        expect(parsed.status, `${locale}:${status}`).toBe(status);
      }
    }
    expect(stockCreateSchema.parse({ name: "a", status: "Verliehen" }).status).toBe("ON_LOAN");
    expect(stockCreateSchema.parse({ name: "a", status: "on loan" }).status).toBe("ON_LOAN");
    expect(stockCreateSchema.parse({ name: "a", status: "AVAILABLE" }).status).toBe("AVAILABLE");
    expect(stockCreateSchema.safeParse({ name: "a", status: "nope" }).success).toBe(false);
  });

  it("task import accepts status and priority in German, English or enum form", () => {
    const row = (status: string, priority: string) =>
      taskCsvRowSchema.parse({ title: "T", status, priority });
    expect(row("In Arbeit", "Hoch")).toMatchObject({ status: "IN_PROGRESS", priority: "HIGH" });
    expect(row("in progress", "high")).toMatchObject({ status: "IN_PROGRESS", priority: "HIGH" });
    expect(row("To do", "Urgent")).toMatchObject({ status: "TODO", priority: "URGENT" });
    expect(row("Offen", "Dringend")).toMatchObject({ status: "TODO", priority: "URGENT" });
    expect(row("BLOCKED", "LOWEST")).toMatchObject({ status: "BLOCKED", priority: "LOWEST" });
    expect(taskCsvRowSchema.safeParse({ title: "T", status: "wat" }).success).toBe(false);
    expect(taskCsvRowSchema.safeParse({ title: "T", priority: "wat" }).success).toBe(false);
  });

  it("every enum value round-trips through both language vocabularies", () => {
    for (const status of Object.values(TaskStatus)) {
      for (const locale of ["de", "en"] as const) {
        const parsed = taskCsvRowSchema.parse({
          title: "T",
          status: taskStatusLabel(locale, status),
        });
        expect(parsed.status, `${locale}:${status}`).toBe(status);
      }
    }
    for (const priority of Object.values(TaskPriority)) {
      for (const locale of ["de", "en"] as const) {
        const parsed = taskCsvRowSchema.parse({
          title: "T",
          priority: taskPriorityLabel(locale, priority),
        });
        expect(parsed.priority, `${locale}:${priority}`).toBe(priority);
      }
    }
  });
});

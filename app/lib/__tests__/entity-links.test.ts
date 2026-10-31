import { describe, expect, it } from "vitest";
import { entityHref } from "~/lib/entity-links";
import { ENTITY_TYPES } from "~/lib/realtime/events";

/** `entityHref`: every pageable entity type maps to its real route;
 *  slug-routed entities need `ref.slug`; types without a page → `null`. */
describe("entityHref", () => {
  it("maps id-routed entities", () => {
    expect(entityHref("task", { id: "t1" })).toBe("/tasks/t1");
    expect(entityHref("ticket", { id: "k1" })).toBe("/tickets/k1");
    expect(entityHref("note", { id: "n1" })).toBe("/notes/n1");
    expect(entityHref("location", { id: "l1" })).toBe("/locations/l1");
    expect(entityHref("inventory-item", { id: "s1" })).toBe("/inventory/stock/s1");
    expect(entityHref("equipment", { id: "e1" })).toBe("/inventory/e1");
    expect(entityHref("equipmentModel", { id: "m1" })).toBe("/inventory/models/m1");
    expect(entityHref("event", { id: "v1" })).toBe("/events/v1");
    expect(entityHref("user", { id: "u1" })).toBe("/admin/users/u1");
  });

  it("maps slug-routed entities and returns null without the slug", () => {
    expect(entityHref("project", { id: "p1", slug: "umbau" })).toBe("/projects/umbau");
    expect(entityHref("room", { id: "r1", slug: "k-11-23" })).toBe("/rooms/k-11-23");
    expect(entityHref("project", { id: "p1" })).toBeNull();
    expect(entityHref("room", { id: "r1" })).toBeNull();
  });

  it("returns null for types with no detail page and for legacy spellings", () => {
    expect(entityHref("campus", { id: "c1" })).toBeNull();
    expect(entityHref("attachment", { id: "a1" })).toBeNull();
    expect(entityHref("activityLog", { id: "x" })).toBeNull();
    expect(entityHref("Ticket", { id: "k1" })).toBeNull(); // legacy casing
    expect(entityHref("whatever", { id: "x" })).toBeNull();
  });

  it("never throws on any ENTITY_TYPES member", () => {
    for (const t of ENTITY_TYPES) {
      expect(() => entityHref(t, { id: "x", slug: "y" })).not.toThrow();
    }
  });
});

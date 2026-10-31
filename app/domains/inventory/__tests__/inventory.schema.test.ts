import { describe, expect, it } from "vitest";
import { equipmentCsvRowSchema } from "~/domains/inventory/inventory.schema";

/**
 * The CSV bulk-import schema must reject malformed ip/mac the same way
 * the manual create/edit form does (equipmentCreateSchema's optionalIp/optionalMac),
 * instead of accepting arbitrary text.
 */

function row(over: Record<string, unknown> = {}) {
  return {
    kategorie: "pc",
    mobilitaet: "mobil",
    status: "ok",
    ...over,
  };
}

describe("equipmentCsvRowSchema ip/mac validation", () => {
  it("accepts a well-formed IPv4 and MAC", () => {
    const result = equipmentCsvRowSchema.safeParse(
      row({ ip: "192.0.2.10", mac: "02:00:00:DD:EE:FF" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a malformed IP address", () => {
    const result = equipmentCsvRowSchema.safeParse(row({ ip: "not-an-ip" }));
    expect(result.success).toBe(false);
  });

  it("rejects a malformed MAC address", () => {
    const result = equipmentCsvRowSchema.safeParse(row({ mac: "not-a-mac" }));
    expect(result.success).toBe(false);
  });

  it("allows empty ip/mac (optional fields)", () => {
    const result = equipmentCsvRowSchema.safeParse(row({ ip: "", mac: "" }));
    expect(result.success).toBe(true);
  });
});

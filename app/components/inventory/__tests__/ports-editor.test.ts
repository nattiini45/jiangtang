import { describe, expect, it } from "vitest";
import { duplicatePortLabel } from "../ports-editor";
import { modelPortSchema } from "~/domains/inventory/inventory.ports.schema";

describe("numbered port duplication", () => {
  it("increments a trailing number and skips existing labels", () => {
    expect(duplicatePortLabel("HDMI IN 1", new Set(["HDMI IN 1", "HDMI IN 2"]))).toBe("HDMI IN 3");
    expect(duplicatePortLabel("HDMI", new Set(["HDMI"]))).toBe("HDMI 2");
  });
  it("keeps the generated label within 120 characters even when the suffix grows", () => {
    const original = "9".repeat(120);
    const label = duplicatePortLabel(original, new Set([original, "0".repeat(120)]));
    expect(label).toHaveLength(120);
    expect(label).not.toBe("0".repeat(120));
    expect(
      modelPortSchema.safeParse({ label, connector: "HDMI", direction: "INPUT", signal: "VIDEO" })
        .success,
    ).toBe(true);
  });
});

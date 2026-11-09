import { describe, expect, it } from "vitest";
import { createMcpAdmissionGate } from "~/lib/mcp/mcp.boot.server";

describe("MCP request admission before body buffering", () => {
  it("bounds each token and the whole process, and releases slots exactly once", () => {
    const admit = createMcpAdmissionGate();
    const first = Array.from({ length: 4 }, () => admit("first"));
    expect(first.every(Boolean)).toBe(true);
    expect(admit("first")).toBeNull();
    const second = Array.from({ length: 4 }, () => admit("second"));
    expect(second.every(Boolean)).toBe(true);
    expect(admit("third")).toBeNull();
    first[0]!();
    first[0]!();
    const replacement = admit("third");
    expect(replacement).not.toBeNull();
    expect(admit("fourth")).toBeNull();
    for (const release of [...first, ...second, replacement]) release!();
    expect(Array.from({ length: 4 }, () => admit("new")).every(Boolean)).toBe(true);
  });
});

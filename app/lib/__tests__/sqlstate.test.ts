import { describe, expect, it } from "vitest";
import { hasSqlState } from "~/lib/errors.server";

describe("hasSqlState", () => {
  it("finds the SQLSTATE on the driver adapter cause of a Prisma error", () => {
    // Shape raised by @prisma/adapter-pg 7.10 for a Restrict violation.
    const restrict = {
      code: "P2003",
      meta: {
        modelName: "Location",
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { originalCode: "23001", kind: "RestrictViolation" },
        },
      },
    };
    expect(hasSqlState(restrict, "23001")).toBe(true);
    expect(hasSqlState(restrict, "P2003")).toBe(true);
    expect(hasSqlState(restrict, "23505")).toBe(false);
  });

  it("still matches a SQLSTATE on the cause chain and a Prisma code", () => {
    expect(hasSqlState({ cause: { code: "23505" } }, "23505")).toBe(true);
    expect(hasSqlState({ code: "P2002" }, "P2002")).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(hasSqlState(new Error("boom"), "23001")).toBe(false);
    expect(hasSqlState(undefined, "23001")).toBe(false);
  });
});

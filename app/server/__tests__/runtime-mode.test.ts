import { describe, expect, it } from "vitest";
import { resolveRuntimeMode } from "~/server/runtime-mode";

/**
 * The entry point's NODE_ENV normalisation and trust-proxy decision. server.ts runs
 * listen and top-level await on import, so the decision lives in this pure function.
 * The environment is passed explicitly, so the result does not depend on the
 * developer's shell.
 */

describe("resolveRuntimeMode", () => {
  it("treats an unset NODE_ENV as production with one trusted proxy hop", () => {
    expect(resolveRuntimeMode({})).toEqual({
      development: false,
      nodeEnv: "production",
      trustProxy: 1,
    });
  });

  it("gives development behaviour only to the exact value development", () => {
    expect(resolveRuntimeMode({ NODE_ENV: "development" })).toEqual({
      development: true,
      nodeEnv: "development",
      trustProxy: false,
    });
  });

  it.each(["production", "test", "Development", ""])(
    "treats NODE_ENV=%j as production",
    (value) => {
      expect(resolveRuntimeMode({ NODE_ENV: value })).toEqual({
        development: false,
        nodeEnv: "production",
        trustProxy: 1,
      });
    },
  );

  it("does not change the environment it is given", () => {
    const env = { NODE_ENV: "test" };
    resolveRuntimeMode(env);
    expect(env).toEqual({ NODE_ENV: "test" });
  });
});

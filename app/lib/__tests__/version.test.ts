import { afterEach, expect, it, vi } from "vitest";
import packageJson from "../../../package.json";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("reads the package version and uses unknown without a commit stamp", async () => {
  vi.stubEnv("APP_COMMIT", "");
  const { buildInfo } = await import("~/lib/version.server");
  expect(buildInfo).toEqual({ version: packageJson.version, commit: "unknown" });
});

it("reads the image's commit stamp", async () => {
  vi.stubEnv("APP_COMMIT", "a".repeat(40));
  const { buildInfo } = await import("~/lib/version.server");
  expect(buildInfo.commit).toBe("a".repeat(40));
});

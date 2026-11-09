import { afterAll, beforeAll, vi } from "vitest";

export function configuredCalendarFixture(): void {
  beforeAll(() => {
    vi.stubEnv("CALDAV_URL", "https://calendar.example.test/collection/");
    vi.stubEnv("CALDAV_USERNAME", "synthetic-user");
    vi.stubEnv("CALDAV_PASSWORD", "synthetic-password");
  });
  afterAll(() => vi.unstubAllEnvs());
}

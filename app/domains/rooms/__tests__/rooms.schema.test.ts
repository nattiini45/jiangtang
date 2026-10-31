import { describe, expect, it } from "vitest";
import { roomCreateSchema } from "~/domains/rooms/rooms.schema";

/**
 * Regression guard: bookingUrl/manualUrl/virtualTourUrl must reject non-http(s)
 * schemes (javascript:, data:, ...) — these values are rendered directly as
 * `<a href>` in room-dashboard.tsx (ExtLink), so an unconstrained scheme is a
 * stored-XSS vector. Pure schema test, no DB.
 */

function baseInput(bookingUrl: unknown) {
  return {
    name: "Test Saal",
    roomNumber: undefined,
    campusId: undefined,
    newCampusName: undefined,
    buildingId: undefined,
    newBuildingName: undefined,
    capacity: undefined,
    owner: undefined,
    status: "ALL_GOOD",
    hasProjector: false,
    hasMicrophony: false,
    hasBlackboard: false,
    hasWebConference: false,
    hasAutoRecording: false,
    mediaKeyRequired: false,
    videoInputs: [],
    audioOutputs: [],
    bookingUrl,
    manualUrl: undefined,
    virtualTourUrl: undefined,
    tipsNotes: undefined,
    renewalStatus: undefined,
    renewalFrom: undefined,
    renewalTo: undefined,
  };
}

describe("roomCreateSchema — bookingUrl scheme guard", () => {
  it("rejects javascript: URLs", () => {
    const result = roomCreateSchema.safeParse(baseInput("javascript:alert(1)"));
    expect(result.success).toBe(false);
  });

  it("rejects data: URLs", () => {
    const result = roomCreateSchema.safeParse(
      baseInput("data:text/html,<script>alert(1)</script>"),
    );
    expect(result.success).toBe(false);
  });

  it("accepts https URLs", () => {
    const result = roomCreateSchema.safeParse(baseInput("https://example.com"));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.bookingUrl).toBe("https://example.com");
  });

  it("accepts http URLs", () => {
    const result = roomCreateSchema.safeParse(baseInput("http://example.com"));
    expect(result.success).toBe(true);
  });

  it("treats empty string as undefined (optional field)", () => {
    const result = roomCreateSchema.safeParse(baseInput(""));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.bookingUrl).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { eventCreateSchema, eventEditSchema, roomBookingSchema } from "../events.schema";

const input = {
  title: "Synthetic event",
  startsAt: "2026-10-25T02:30",
  endsAt: "2026-10-25T02:15",
  startsAtInstant: "2026-10-25T00:30:00.000Z",
  endsAtInstant: "2026-10-25T01:15:00.000Z",
};

describe("event edit time validation", () => {
  it("accepts locally descending endpoints when matching exact instants are ordered", () => {
    expect(eventEditSchema.parse(input)).toMatchObject(input);
  });

  it("rejects reversed or equal exact instants even when local endpoints look ordered", () => {
    expect(
      eventEditSchema.safeParse({
        ...input,
        startsAt: "2026-10-25T02:15",
        endsAt: "2026-10-25T02:30",
        startsAtInstant: "2026-10-25T01:15:00.000Z",
        endsAtInstant: "2026-10-25T00:30:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      eventEditSchema.safeParse({
        ...input,
        endsAt: input.startsAt,
        endsAtInstant: input.startsAtInstant,
      }).success,
    ).toBe(false);
  });

  it("uses fallback conversion for a changed endpoint and ignores its stale hint", () => {
    expect(eventEditSchema.safeParse({ ...input, endsAt: "2026-10-25T03:15" }).success).toBe(true);
    expect(eventEditSchema.safeParse({ ...input, startsAt: "2026-10-25T02:45" }).success).toBe(
      false,
    );
  });

  it("keeps hints optional and rejects malformed exact instants", () => {
    const ordinary = { title: input.title, startsAt: input.endsAt, endsAt: input.startsAt };
    expect(eventEditSchema.safeParse(ordinary).success).toBe(true);
    expect(
      eventEditSchema.safeParse({ ...ordinary, startsAtInstant: "not-an-instant" }).success,
    ).toBe(false);
    expect(
      eventEditSchema.safeParse({ ...ordinary, endsAtInstant: "2026-10-25T02:30" }).success,
    ).toBe(false);
  });

  it("does not add exact hints or cross-fold ordering to creation or booking schemas", () => {
    expect(eventCreateSchema.safeParse(input).success).toBe(false);
    expect(roomBookingSchema.safeParse({ ...input, roomId: "synthetic-room" }).success).toBe(false);
    const ordered = { ...input, startsAt: input.endsAt, endsAt: input.startsAt };
    expect(eventCreateSchema.parse(ordered)).not.toHaveProperty("startsAtInstant");
    expect(eventCreateSchema.parse(ordered)).not.toHaveProperty("endsAtInstant");
    expect(roomBookingSchema.parse({ ...ordered, roomId: "synthetic-room" })).not.toHaveProperty(
      "startsAtInstant",
    );
  });
});

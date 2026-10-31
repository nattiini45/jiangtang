import { describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";

/**
 * DB sessions must run in UTC. The PrismaPg adapter serialises a JS Date
 * as an offset-less UTC wall-clock string ("YYYY-MM-DD HH:MM:SS.mmm") and reads
 * timestamptz text with the server's offset stripped to "+00:00" — both correct
 * IFF the session TimeZone is UTC. With Europe/Berlin sessions every written
 * instant landed one zone-offset early while Prisma reads masked
 * it.
 */
class Rollback extends Error {}

const EXPECTED = 1791453600; // 2026-10-08T10:00:00.000Z

describe("DB session timezone is UTC", () => {
  it("stores and reads exact instants; defaults track SQL now()", async () => {
    const observed = await db
      .$transaction(async (tx) => {
        const slug = `tzprobe-${Date.now()}`;
        const proj = await tx.project.create({
          data: {
            name: "tzprobe",
            slug,
            status: "REQUESTED",
            startAt: new Date("2026-10-08T10:00:00.000Z"),
          },
        });
        const rows = await tx.$queryRawUnsafe<
          Array<{
            tz: string;
            start_epoch: number;
            created_epoch: number;
            now_epoch: number;
          }>
        >(
          `SELECT current_setting('TimeZone') AS tz,
                  extract(epoch from "startAt")::float8 AS start_epoch,
                  extract(epoch from "createdAt")::float8 AS created_epoch,
                  extract(epoch from now())::float8 AS now_epoch
           FROM "Project" WHERE id = $1`,
          proj.id,
        );
        throw new Rollback(JSON.stringify(rows[0]));
      })
      .then(() => {
        throw new Error("transaction should have rolled back");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
        return JSON.parse(e.message) as {
          tz: string;
          start_epoch: number;
          created_epoch: number;
          now_epoch: number;
        };
      });

    expect(observed.tz).toBe("UTC");
    expect(observed.start_epoch).toBe(EXPECTED);
    expect(Math.abs(observed.created_epoch - observed.now_epoch)).toBeLessThan(5);
  });
});

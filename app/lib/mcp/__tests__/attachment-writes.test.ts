import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { db } from "~/lib/db.server";
import { FsStorageProvider } from "~/lib/storage/fs-provider";
import { getStorage, setStorageProvider } from "~/lib/storage/storage.server";
import { MAX_UPLOAD_BYTES } from "~/lib/storage/image.server";
import * as realtime from "~/lib/realtime/emit.server";
import { registerAttachmentWrites } from "~/lib/mcp/attachment-writes.server";
import type { McpContext } from "~/lib/mcp/types.server";
import {
  decodeAttachmentBase64,
  attachmentTransferSchema,
} from "~/domains/attachments/attachments.transfer.server";
import { fetchAttachmentUrl } from "~/domains/attachments/attachment-url.server";

vi.mock("~/domains/attachments/attachment-url.server", () => ({ fetchAttachmentUrl: vi.fn() }));

const previousProvider = getStorage();
const originalEmit = realtime.emitChange;
const emitted = vi.spyOn(realtime, "emitChange");
const run = crypto.randomUUID();
let directory: string;
let roomId: string;
let campusId: string;
let context: McpContext;
let image: Buffer;
let createdId: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "jiangtang-mcp-attachment-"));
  setStorageProvider(new FsStorageProvider(directory));
  const user = await db.user.create({
    data: { name: "Synthetic image agent", email: `attachment-${run}@example.test` },
  });
  context = {
    user: { ...user, role: "MEMBER" },
    token: { id: `synthetic-token-${run}`, name: "Image agent", scope: "READ_WRITE" },
  };
  const campus = await db.campus.create({
    data: { name: `Attachment ${run}`, slug: `attachment-${run}` },
  });
  campusId = campus.id;
  const room = await db.room.create({
    data: { name: "Synthetic image room", slug: `attachment-${run}`, campusId },
  });
  roomId = room.id;
  image = await sharp({ create: { width: 16, height: 9, channels: 3, background: "#123456" } })
    .withExif({
      IFD0: { Copyright: "Synthetic fixture", Software: "Synthetic test" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "51/1 30/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "13/1 24/1 0/1",
      },
    })
    .jpeg()
    .toBuffer();
  emitted.mockImplementation(async (event) => {
    if (event.entityType === "attachment") {
      const row = await db.attachment.findUnique({ where: { id: event.id } });
      expect(Boolean(row)).toBe(event.op !== "deleted");
      const action = event.op === "deleted" ? "AttachmentRemoved" : "AttachmentAdded";
      expect(await db.activityLog.count({ where: { entityId: event.id, action } })).toBe(1);
    }
    return originalEmit(event);
  });
});

afterAll(async () => {
  emitted.mockRestore();
  if (roomId) await db.attachment.deleteMany({ where: { roomId } });
  if (roomId) await db.room.delete({ where: { id: roomId } });
  if (campusId) await db.campus.delete({ where: { id: campusId } });
  if (context) await db.user.delete({ where: { id: context.user.id } });
  setStorageProvider(previousProvider);
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function connect(principal = context) {
  const server = new McpServer({ name: "attachment-test", version: "1" });
  registerAttachmentWrites(server, principal);
  const client = new Client({ name: "attachment-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function upload(overrides: Record<string, unknown> = {}) {
  return {
    category: "ROOM",
    roomId,
    filename: "synthetic.jpg",
    contentType: "image/jpeg",
    base64: image.toString("base64"),
    ...overrides,
  };
}

describe("attachment transfer validation", () => {
  it.each([
    "",
    "a",
    "Zg",
    "Zg=",
    "Zg===",
    "Zg==\n",
    "Zh==",
    "Zm9=",
    "Zg__",
    "data:image/png;base64,Zg==",
    "!!!!",
  ])("rejects malformed or noncanonical base64 %j", (value) =>
    expect(() => decodeAttachmentBase64(value)).toThrow(Response),
  );

  it("accepts canonical base64 and bounds decoded bytes before storage", () => {
    expect(decodeAttachmentBase64("Zg==")).toEqual(Buffer.from("f"));
    expect(decodeAttachmentBase64(Buffer.alloc(MAX_UPLOAD_BYTES).toString("base64"))).toHaveLength(
      MAX_UPLOAD_BYTES,
    );
    expect(() =>
      decodeAttachmentBase64(Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64")),
    ).toThrow(Response);
  });

  it.each([
    "../secret.jpg",
    "a/b.jpg",
    "a\\b.jpg",
    "bad\0.jpg",
    "bad\n.jpg",
    "bad\u202e.jpg",
    ".",
    "..",
    " ",
    "a".repeat(256),
  ])("rejects unsafe filename %j", (filename) =>
    expect(attachmentTransferSchema.safeParse(upload({ filename })).success).toBe(false),
  );

  it("requires exactly one source and exactly one attachment parent", () => {
    expect(attachmentTransferSchema.safeParse(upload({ base64: undefined })).success).toBe(false);
    expect(
      attachmentTransferSchema.safeParse(upload({ url: "https://example.com/a.jpg" })).success,
    ).toBe(false);
    expect(attachmentTransferSchema.safeParse(upload({ ticketId: "other" })).success).toBe(false);
    expect(attachmentTransferSchema.safeParse(upload({ roomId: undefined })).success).toBe(false);
    expect(attachmentTransferSchema.safeParse(upload({ contentType: "text/html" })).success).toBe(
      false,
    );
  });
});

describe("attachment MCP writes through the actual storage provider", () => {
  it("registers write/destructive annotations and refuses read-only writes before fetching", async () => {
    const session = await connect({ ...context, token: { ...context.token, scope: "READ_ONLY" } });
    try {
      const { tools } = await session.client.listTools();
      expect(tools.find(({ name }) => name === "upload_attachment")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
      expect(tools.find(({ name }) => name === "delete_attachment")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      const result = await session.client.callTool({
        name: "upload_attachment",
        arguments: upload({ base64: undefined, url: "https://example.com/photo.jpg" }),
      });
      expect(result.isError).toBe(true);
      expect(fetchAttachmentUrl).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("strips image EXIF/GPS, encrypts bytes, audits the MCP actor and returns only safe metadata", async () => {
    expect((await sharp(image).metadata()).exif).toBeTruthy();
    const session = await connect();
    try {
      const result = await session.client.callTool({
        name: "upload_attachment",
        arguments: upload(),
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const metadata = (result.structuredContent as { result: { id: string; filename: string } })
        .result;
      createdId = metadata.id;
      expect(metadata.filename).toBe("synthetic.jpg");
      expect(metadata).not.toHaveProperty("objectKey");
      const row = await db.attachment.findUniqueOrThrow({ where: { id: createdId } });
      expect(row).toMatchObject({ contentType: "image/jpeg", width: 16, height: 9, roomId });
      const stored = await getStorage().get(row.objectKey);
      const processed = await sharp(stored.body).metadata();
      expect(processed.exif).toBeUndefined();
      expect(processed.xmp).toBeUndefined();
      expect(processed.icc).toBeUndefined();
      const ciphertext = await readFile(join(directory, row.objectKey.slice(0, 2), row.objectKey));
      expect(ciphertext.equals(stored.body)).toBe(false);
      const audit = await db.activityLog.findFirstOrThrow({
        where: { entityId: row.id, action: "AttachmentAdded" },
      });
      expect(audit.actorId).toBe(context.user.id);
      expect(audit.actorSnapshot).toMatchObject({
        via: "via MCP (Image agent)",
        tokenId: context.token.id,
      });
      expect(emitted).toHaveBeenCalledWith({ entityType: "attachment", id: row.id, op: "created" });
      expect(emitted).toHaveBeenCalledWith({ entityType: "room", id: roomId, op: "updated" });
    } finally {
      await session.close();
    }
  });

  it("runs URL image bytes through the same real image storage pipeline", async () => {
    vi.mocked(fetchAttachmentUrl).mockResolvedValue({ body: image, contentType: "image/jpeg" });
    const session = await connect();
    try {
      const result = await session.client.callTool({
        name: "upload_attachment",
        arguments: upload({ base64: undefined, url: "https://example.com/photo.jpg" }),
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const metadata = (result.structuredContent as { result: { id: string } }).result;
      const row = await db.attachment.findUniqueOrThrow({ where: { id: metadata.id } });
      expect(
        (await sharp((await getStorage().get(row.objectKey)).body).metadata()).exif,
      ).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it("rejects mismatched types, non-images and corrupt images without inserting metadata", async () => {
    const count = await db.attachment.count({ where: { roomId } });
    const session = await connect();
    try {
      for (const args of [
        upload({ contentType: "image/png" }),
        upload({ base64: Buffer.from("not an image").toString("base64") }),
        upload({ base64: Buffer.from([0xff, 0xd8, 0xff, 0]).toString("base64") }),
      ]) {
        const result = await session.client.callTool({
          name: "upload_attachment",
          arguments: args,
        });
        expect(result.isError).toBe(true);
      }
      expect(await db.attachment.count({ where: { roomId } })).toBe(count);
    } finally {
      await session.close();
    }
  });

  it("requires confirmation for deletion then audits, notifies and removes encrypted bytes", async () => {
    const row = await db.attachment.findUniqueOrThrow({ where: { id: createdId } });
    const session = await connect();
    try {
      for (const args of [{ id: row.id }, { id: row.id, confirm: false }]) {
        expect(
          (await session.client.callTool({ name: "delete_attachment", arguments: args })).isError,
        ).toBe(true);
        expect(await db.attachment.findUnique({ where: { id: row.id } })).not.toBeNull();
      }
      const result = await session.client.callTool({
        name: "delete_attachment",
        arguments: { id: row.id, confirm: true },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect((result.structuredContent as { result: unknown }).result).not.toHaveProperty(
        "objectKey",
      );
      expect(await db.attachment.findUnique({ where: { id: row.id } })).toBeNull();
      await expect(getStorage().get(row.objectKey)).rejects.toThrow();
      expect(emitted).toHaveBeenCalledWith({ entityType: "attachment", id: row.id, op: "deleted" });
      const audit = await db.activityLog.findFirstOrThrow({
        where: { entityId: row.id, action: "AttachmentRemoved" },
      });
      expect(audit.actorSnapshot).toMatchObject({
        via: "via MCP (Image agent)",
        tokenId: context.token.id,
      });
    } finally {
      await session.close();
    }
  });
});

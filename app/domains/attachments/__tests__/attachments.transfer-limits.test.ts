import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditActor } from "~/lib/audit.server";
import type { Attachment } from "~/generated/prisma/client";
import { NotFoundError } from "~/lib/errors.server";
import { getRoom } from "~/domains/rooms/rooms.queries.server";
import { getEquipment } from "~/domains/inventory/inventory.queries.server";
import { getTicket } from "~/domains/tickets/tickets.queries.server";
import { createAttachment } from "~/domains/attachments/attachments.mutations.server";
import { fetchAttachmentUrl } from "~/domains/attachments/attachment-url.server";
import {
  ATTACHMENT_UPLOAD_LIMIT,
  ATTACHMENT_UPLOAD_WINDOW_MS,
  uploadAttachmentTransfer,
} from "~/domains/attachments/attachments.transfer.server";

vi.mock("~/domains/rooms/rooms.queries.server", () => ({ getRoom: vi.fn() }));
vi.mock("~/domains/inventory/inventory.queries.server", () => ({ getEquipment: vi.fn() }));
vi.mock("~/domains/tickets/tickets.queries.server", () => ({ getTicket: vi.fn() }));
vi.mock("~/domains/attachments/attachments.mutations.server", () => ({
  createAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));
vi.mock("~/domains/attachments/attachment-url.server", () => ({ fetchAttachmentUrl: vi.fn() }));
vi.mock("~/lib/realtime/emit.server", () => ({ emitChange: vi.fn() }));

const body = Buffer.from([0xff, 0xd8, 0xff]);
const attachment: Attachment = {
  id: "synthetic-attachment",
  objectKey: "opaque.jpg",
  category: "ROOM",
  filename: "fixture.jpg",
  contentType: "image/jpeg",
  sizeBytes: body.length,
  width: 1,
  height: 1,
  roomId: "room",
  equipmentId: null,
  ticketId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  createdById: null,
};

function actor(): AuditActor {
  return {
    id: crypto.randomUUID(),
    via: { kind: "mcp", tokenId: crypto.randomUUID(), tokenName: "Synthetic" },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    category: "ROOM",
    roomId: "room",
    filename: "fixture.jpg",
    contentType: "image/jpeg",
    base64: body.toString("base64"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getRoom).mockResolvedValue({ id: "room" } as NonNullable<
    Awaited<ReturnType<typeof getRoom>>
  >);
  vi.mocked(getEquipment).mockResolvedValue({ id: "equipment" } as NonNullable<
    Awaited<ReturnType<typeof getEquipment>>
  >);
  vi.mocked(getTicket).mockResolvedValue({ id: "ticket" } as NonNullable<
    Awaited<ReturnType<typeof getTicket>>
  >);
  vi.mocked(createAttachment).mockResolvedValue(attachment);
  vi.mocked(fetchAttachmentUrl).mockResolvedValue({ body, contentType: "image/jpeg" });
});

afterEach(() => vi.restoreAllMocks());

describe("attachment upload admission", () => {
  it("admits only two uploads across different tokens and rejects a third without queuing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetchAttachmentUrl).mockImplementation(async () => {
      await gate;
      return { body, contentType: "image/jpeg" };
    });
    const first = uploadAttachmentTransfer(
      actor(),
      input({ base64: undefined, url: "https://example.com/a.jpg" }),
    );
    const second = uploadAttachmentTransfer(
      actor(),
      input({ base64: undefined, url: "https://example.com/b.jpg" }),
    );
    try {
      await vi.waitFor(() => expect(fetchAttachmentUrl).toHaveBeenCalledTimes(2));
      await expect(uploadAttachmentTransfer(actor(), input())).rejects.toMatchObject({
        status: 429,
      });
      expect(getRoom).toHaveBeenCalledTimes(2);
      expect(createAttachment).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([first, second]);
    }
    await expect(uploadAttachmentTransfer(actor(), input())).resolves.toHaveProperty("id");
  });

  it("releases both slots after failed transfers", async () => {
    vi.mocked(fetchAttachmentUrl).mockRejectedValue(
      new Response("Synthetic failure", { status: 422 }),
    );
    await Promise.all(
      [1, 2].map(() =>
        expect(
          uploadAttachmentTransfer(
            actor(),
            input({ base64: undefined, url: "https://example.com/fail.jpg" }),
          ),
        ).rejects.toMatchObject({ status: 422 }),
      ),
    );
    await expect(uploadAttachmentTransfer(actor(), input())).resolves.toHaveProperty("id");
  });

  it("limits each token to ten uploads per minute independently of its user", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const principal = actor();
    for (let i = 0; i < ATTACHMENT_UPLOAD_LIMIT; i++)
      await uploadAttachmentTransfer(principal, input());
    await expect(uploadAttachmentTransfer(principal, input())).rejects.toMatchObject({
      status: 429,
    });
    expect(createAttachment).toHaveBeenCalledTimes(ATTACHMENT_UPLOAD_LIMIT);
    await expect(
      uploadAttachmentTransfer(
        {
          ...principal,
          via: { kind: "mcp", tokenId: crypto.randomUUID(), tokenName: "Other token" },
        },
        input(),
      ),
    ).resolves.toHaveProperty("id");
    now += ATTACHMENT_UPLOAD_WINDOW_MS;
    await expect(uploadAttachmentTransfer(principal, input())).resolves.toHaveProperty("id");
  });

  it("uses actor IDs when there is no MCP token and counts failed admitted attempts", async () => {
    const principal: AuditActor = { id: crypto.randomUUID() };
    for (let i = 0; i < ATTACHMENT_UPLOAD_LIMIT; i++) {
      await expect(
        uploadAttachmentTransfer(principal, input({ base64: "!!!!" })),
      ).rejects.toMatchObject({ status: 422 });
    }
    await expect(uploadAttachmentTransfer(principal, input())).rejects.toMatchObject({
      status: 429,
    });
    await expect(
      uploadAttachmentTransfer({ id: crypto.randomUUID() }, input()),
    ).resolves.toHaveProperty("id");
  });
});

describe("attachment parent prechecks", () => {
  it.each([
    ["room", { roomId: "missing-room" }, getRoom],
    [
      "equipment",
      { category: "EQUIPMENT", roomId: undefined, equipmentId: "missing-equipment" },
      getEquipment,
    ],
    ["ticket", { category: "TICKET", roomId: undefined, ticketId: "missing-ticket" }, getTicket],
  ] as const)(
    "rejects a nonexistent %s before URL fetching or base64 decoding",
    async (_name, target, query) => {
      vi.mocked(query).mockResolvedValue(null);
      await expect(
        uploadAttachmentTransfer(
          actor(),
          input({ ...target, base64: undefined, url: "https://example.com/photo.jpg" }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        uploadAttachmentTransfer(actor(), input({ ...target, base64: "!!!!" })),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(query).toHaveBeenCalledTimes(2);
      expect(fetchAttachmentUrl).not.toHaveBeenCalled();
      expect(createAttachment).not.toHaveBeenCalled();
    },
  );
});

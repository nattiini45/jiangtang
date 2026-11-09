import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_FETCH_TIMEOUT_MS,
  attachmentUrl,
  fetchAttachmentUrl,
  isPublicAttachmentAddress,
} from "~/domains/attachments/attachment-url.server";
import { MAX_UPLOAD_BYTES } from "~/lib/storage/image.server";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

const lookupAll = vi.mocked(
  lookup as (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>,
);

let status = 200;
let headers: IncomingMessage["headers"];
let chunks: Buffer[];
let stall = false;
let stallBody = false;
let lastResponse: PassThrough;
let lastOptions: RequestOptions;

beforeEach(() => {
  vi.resetAllMocks();
  status = 200;
  headers = { "content-type": "image/png" };
  chunks = [Buffer.from("synthetic image payload")];
  stall = false;
  stallBody = false;
  lookupAll.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  vi.mocked(request).mockImplementation((...args: unknown[]) => {
    lastOptions = args[1] as RequestOptions;
    const callback = args[2] as (response: IncomingMessage) => void;
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    let currentResponse: PassThrough | undefined;
    lastOptions.signal?.addEventListener(
      "abort",
      () => {
        req.emit("error", new Error("aborted"));
        currentResponse?.destroy(new Error("aborted"));
      },
      { once: true },
    );
    req.end = () => {
      if (stall) return;
      lastResponse = new PassThrough();
      currentResponse = lastResponse;
      Object.assign(lastResponse, { statusCode: status, headers });
      callback(lastResponse as unknown as IncomingMessage);
      for (const chunk of chunks) lastResponse.write(chunk);
      if (!stallBody) lastResponse.end();
    };
    return req as ReturnType<typeof request>;
  });
});

afterEach(() => vi.useRealTimers());

describe("attachment URL address policy", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:93.184.216.34",
    "64:ff9b::7f00:1",
    "100::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "fc00::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "not-an-address",
  ])("rejects non-public or translated address %s", (address) => {
    expect(isPublicAttachmentAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => expect(isPublicAttachmentAddress(address)).toBe(true),
  );

  it.each([
    "http://example.com/image.png",
    "https://example.com:8443/image.png",
    "https://example.com:80/image.png",
    "https://example..com/image.png",
    "https://.example.com/image.png",
    "https://example.com../image.png",
    "file:///etc/passwd",
    "https://user:secret@example.com/image",
    "https://example.com/#fragment",
    "https://example.com/#",
    "https://localhost/image",
    "https://localhost./image",
    "https://metadata/image",
    "https://metadata.google.internal/image",
    "https://host.local/image",
    "https://host.lan/image",
    "https://host.home.arpa/image",
    "https://host.localdomain/image",
    "https://host.intranet/image",
    "https://127.0.0.1/image",
    "https://2130706433/image",
    "https://0x7f000001/image",
    "https://[::1]/image",
    "https://[::ffff:127.0.0.1]/image",
    "https://[::ffff:7f00:1]/image",
  ])("rejects unsafe URL without DNS or HTTP: %s", async (url) => {
    expect(() => attachmentUrl(url)).toThrow(Response);
    await expect(fetchAttachmentUrl(url)).rejects.toBeInstanceOf(Response);
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("bounded and DNS-pinned HTTPS image fetch", () => {
  it("accepts the explicit standard HTTPS port", async () => {
    await expect(
      fetchAttachmentUrl("https://images.example.com:443/photo.png"),
    ).resolves.toHaveProperty("contentType", "image/png");
  });

  it("returns the same safe error for private DNS and failed lookups", async () => {
    lookupAll.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const privateFailure = await fetchAttachmentUrl("https://images.example.com/photo.png").catch(
      (error: unknown) => error,
    );
    lookupAll.mockRejectedValue(new Error("Synthetic secret DNS detail"));
    const lookupFailure = await fetchAttachmentUrl("https://images.example.com/photo.png").catch(
      (error: unknown) => error,
    );
    expect(privateFailure).toBeInstanceOf(Response);
    expect(lookupFailure).toBeInstanceOf(Response);
    expect((privateFailure as Response).status).toBe((lookupFailure as Response).status);
    expect(await (privateFailure as Response).text()).toBe(
      await (lookupFailure as Response).text(),
    );
    expect(request).not.toHaveBeenCalled();
  });
  it("pins the validated answer for every connection lookup without forwarding credentials", async () => {
    const result = await fetchAttachmentUrl("https://images.example.com/photo.png");
    expect(result).toEqual({ body: Buffer.concat(chunks), contentType: "image/png" });
    expect(lookup).toHaveBeenCalledExactlyOnceWith("images.example.com", {
      all: true,
      verbatim: true,
    });
    lookupAll.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const pin = lastOptions.lookup!;
    const single = vi.fn();
    const all = vi.fn();
    pin("images.example.com", {}, single);
    pin("images.example.com", { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(lastOptions.agent).toBe(false);
    expect((vi.mocked(request).mock.calls[0][0] as URL).hostname).toBe("images.example.com");
    expect(lastOptions.headers).toEqual({
      Accept: "image/jpeg, image/png, image/webp",
      "Accept-Encoding": "identity",
    });
    expect(lastOptions).not.toHaveProperty("auth");
    expect(lastResponse.destroyed).toBe(true);
  });

  it.each(["127.0.0.1", "192.168.0.1", "::ffff:7f00:1", "fe80::1", "2001:db8::1"])(
    "rejects a private DNS answer even alongside a public answer: %s",
    async (address) => {
      lookupAll.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address, family: address.includes(":") ? 6 : 4 },
      ]);
      await expect(
        fetchAttachmentUrl("https://images.example.com/photo.png"),
      ).rejects.toMatchObject({ status: 422 });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("allows a validated literal public IP without a DNS request", async () => {
    await fetchAttachmentUrl("https://1.1.1.1/photo.png");
    expect(lookup).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects redirect %s without contacting its target",
    async (code) => {
      status = code;
      headers.location = "https://127.0.0.1/private";
      await expect(
        fetchAttachmentUrl("https://images.example.com/photo.png"),
      ).rejects.toMatchObject({ status: 422 });
      expect(request).toHaveBeenCalledTimes(1);
      expect(lastResponse.destroyed).toBe(true);
    },
  );

  it("rejects oversized Content-Length before buffering", async () => {
    headers["content-length"] = String(MAX_UPLOAD_BYTES + 1);
    await expect(fetchAttachmentUrl("https://images.example.com/photo.png")).rejects.toMatchObject({
      status: 413,
    });
    expect(lastResponse.destroyed).toBe(true);
  });

  it("caps chunked bodies even without Content-Length", async () => {
    chunks = [Buffer.alloc(MAX_UPLOAD_BYTES), Buffer.from([1])];
    await expect(fetchAttachmentUrl("https://images.example.com/photo.png")).rejects.toMatchObject({
      status: 413,
    });
    expect(lastResponse.destroyed).toBe(true);
  });

  it.each([
    { "content-type": "text/html" },
    { "content-type": "image/png", "content-encoding": "gzip" },
    { "content-type": "image/png", "content-length": "invalid" },
    { "content-type": "image/png", "content-length": "1" },
  ])("rejects unsupported or inconsistent response headers %j", async (value) => {
    headers = value;
    await expect(fetchAttachmentUrl("https://images.example.com/photo.png")).rejects.toBeInstanceOf(
      Response,
    );
  });

  it("times out DNS before creating a connection", async () => {
    vi.useFakeTimers();
    lookupAll.mockReturnValue(new Promise(() => {}));
    const pending = expect(
      fetchAttachmentUrl("https://images.example.com/photo.png"),
    ).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(ATTACHMENT_FETCH_TIMEOUT_MS);
    await pending;
    expect(request).not.toHaveBeenCalled();
  });

  it("times out a stalled HTTPS request", async () => {
    vi.useFakeTimers();
    stall = true;
    const pending = expect(
      fetchAttachmentUrl("https://images.example.com/photo.png"),
    ).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(ATTACHMENT_FETCH_TIMEOUT_MS);
    await pending;
  });

  it("times out a stalled response body after headers have arrived", async () => {
    vi.useFakeTimers();
    stallBody = true;
    const pending = expect(
      fetchAttachmentUrl("https://images.example.com/photo.png"),
    ).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(ATTACHMENT_FETCH_TIMEOUT_MS);
    await pending;
    expect(lastResponse.destroyed).toBe(true);
  });
});

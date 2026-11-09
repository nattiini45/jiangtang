import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { tr } from "~/i18n/request-locale.server";
import { MAX_UPLOAD_BYTES } from "~/lib/storage/image.server";

export const ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAttachmentAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
  }
  return false;
}

export function attachmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Response(tr("err.mcp.attachmentUrlInvalid"), { status: 422 });
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.href.includes("#")
  ) {
    throw new Response(tr("err.mcp.attachmentUrlRequirements"), {
      status: 422,
    });
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(hostname)) {
    if (!isPublicAttachmentAddress(hostname)) {
      throw new Response(tr("err.mcp.attachmentUrlPublic"), { status: 422 });
    }
  } else if (
    hostname.split(".").some((label) => !label) ||
    !hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|corp|lan|home|arpa|test|invalid|onion)$/.test(
      hostname,
    )
  ) {
    throw new Response(tr("err.mcp.attachmentUrlLocal"), { status: 422 });
  }
  return url;
}

export async function fetchAttachmentUrl(value: string): Promise<{
  body: Buffer;
  contentType: string;
}> {
  const url = attachmentUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  timer.unref();
  let response: IncomingMessage | undefined;
  try {
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
          lookup(hostname, { all: true, verbatim: true }),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
              once: true,
            });
          }),
        ]);
    controller.signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !isPublicAttachmentAddress(address))) {
      throw new Response(tr("err.mcp.attachmentFetchUnsafe"), { status: 422 });
    }
    const pinned = addresses[0];
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          agent: false,
          signal: controller.signal,
          headers: { Accept: "image/jpeg, image/png, image/webp", "Accept-Encoding": "identity" },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });
    if (response.statusCode !== 200) {
      throw new Response(tr("err.mcp.attachmentHttpStatus"), {
        status: 422,
      });
    }
    const contentType = response.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      throw new Response(tr("err.mcp.attachmentImageType"), {
        status: 422,
      });
    }
    if (
      response.headers["content-encoding"] &&
      response.headers["content-encoding"] !== "identity"
    ) {
      throw new Response(tr("err.mcp.attachmentCompressed"), { status: 422 });
    }
    const length = response.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_UPLOAD_BYTES)) {
      throw new Response(tr("err.mcp.attachmentTooLarge"), { status: 413 });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_UPLOAD_BYTES) {
        throw new Response(tr("err.mcp.attachmentTooLarge"), { status: 413 });
      }
      chunks.push(bytes);
    }
    if (!size || (length !== undefined && size !== Number(length))) {
      throw new Response(tr("err.mcp.attachmentIncomplete"), { status: 422 });
    }
    return { body: Buffer.concat(chunks, size), contentType };
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response(tr("err.mcp.attachmentFetchUnsafe"), {
      status: controller.signal.aborted ? 504 : 422,
    });
  } finally {
    clearTimeout(timer);
    response?.destroy();
  }
}

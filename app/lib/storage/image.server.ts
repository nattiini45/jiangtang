import sharp from "sharp";
import { tr } from "~/i18n/request-locale.server";

/**
 * Image ingest: magic-byte validation, EXIF/GPS strip, and thumbnail generation
 * (golden rule: strip EXIF/GPS from every uploaded image on ingest). sharp drops
 * all metadata on re-encode unless withMetadata() is called, so re-encoding
 * without it removes EXIF/GPS; `.rotate()` first bakes the EXIF orientation into
 * the pixels so the visual orientation survives the strip.
 */

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const THUMB_MAX = 400;
// Cap decoded resolution so a small but highly-compressible "decompression bomb"
// (e.g. a 200KB PNG that decodes to 30000×30000) can't force an unbounded
// decode. 100 MP is generous for room/equipment photos.
export const MAX_INPUT_PIXELS = 100_000_000;

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
export const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function contentTypeForKey(objectKey: string): string {
  const ext = objectKey.toLowerCase().split(".").pop() ?? "";
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

/** Sniff a supported image type from the leading bytes; null if unrecognized. */
export function sniffImageType(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

export class UnsupportedImageError extends Error {
  constructor(message = tr("places.err.image.unsupported")) {
    super(message);
    this.name = "UnsupportedImageError";
  }
}

export interface ProcessedImage {
  body: Buffer;
  contentType: string;
  width: number;
  height: number;
  thumbnail: Buffer;
}

/**
 * Validate (magic bytes + decodable), strip EXIF, and produce a normalized image
 * plus a JPEG thumbnail. Throws UnsupportedImageError for non-images.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const sniffed = sniffImageType(input);
  if (!sniffed) throw new UnsupportedImageError();

  try {
    // failOn:"error" rejects truncated/garbage payloads that merely share a
    // magic-byte prefix; limitInputPixels caps decoded resolution. rotate() bakes
    // EXIF orientation before the metadata-stripping re-encode.
    const base = () =>
      sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate();

    let body: Buffer;
    let contentType: string;
    if (sniffed === "image/png") {
      body = await base().png().toBuffer();
      contentType = "image/png";
    } else if (sniffed === "image/webp") {
      body = await base().webp().toBuffer();
      contentType = "image/webp";
    } else {
      body = await base().jpeg({ quality: 85 }).toBuffer();
      contentType = "image/jpeg";
    }

    const meta = await sharp(body).metadata();
    const thumbnail = await base()
      .resize(THUMB_MAX, THUMB_MAX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();

    return { body, contentType, width: meta.width ?? 0, height: meta.height ?? 0, thumbnail };
  } catch (e) {
    // A valid magic-byte prefix with a corrupt body, or an over-limit raster,
    // surfaces as a clean "unsupported image" (mapped to an inline upload error)
    // rather than an opaque 500.
    if (e instanceof UnsupportedImageError) throw e;
    throw new UnsupportedImageError(tr("places.err.image.processFailed"));
  }
}

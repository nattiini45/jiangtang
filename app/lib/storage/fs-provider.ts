import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tr } from "~/i18n/request-locale.server";
import type { GetResult, PutInput, StorageProvider, StoredObject } from "./storage.server";
import { decryptBuffer, encryptBuffer } from "./crypto.server";
import {
  EXT_BY_CONTENT_TYPE,
  MAX_UPLOAD_BYTES,
  contentTypeForKey,
  processImage,
} from "./image.server";

const THUMB_SUFFIX = ".thumb";

/**
 * v1 StorageProvider: encrypted local filesystem. put() validates + strips EXIF +
 * thumbnails (via processImage), then writes the original and a thumbnail as
 * separate AES-GCM-encrypted blobs. Object keys are flat opaque tokens (no
 * slashes → no path traversal); files are sharded by the key's first two chars.
 * Only the key lives in Postgres; the bytes never do.
 */
export class FsStorageProvider implements StorageProvider {
  constructor(private readonly root: string) {}

  private pathFor(objectKey: string): string {
    // Defense-in-depth: object keys are generated internally as opaque
    // `randomUUID()`-based tokens (see put()), so this should never fire in
    // practice — but get()/delete() take a caller-supplied key, so reject
    // anything that could escape the shard directory (traversal, absolute
    // paths, backslashes on Windows hosts, or embedded NULs) before it ever
    // reaches the filesystem.
    if (
      objectKey.length === 0 ||
      objectKey.includes("..") ||
      objectKey.includes("/") ||
      objectKey.includes("\\") ||
      objectKey.includes("\0") ||
      objectKey.startsWith("/")
    ) {
      throw new Error(`Invalid object key: ${objectKey}`);
    }
    const shard = objectKey.slice(0, 2);
    return join(this.root, shard, objectKey);
  }

  private async write(objectKey: string, body: Buffer): Promise<void> {
    const p = this.pathFor(objectKey);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, encryptBuffer(body));
  }

  async put(input: PutInput): Promise<StoredObject> {
    const buf = Buffer.from(input.body);
    if (buf.length > MAX_UPLOAD_BYTES)
      throw new Error(
        tr("places.err.storage.fileTooLarge", { max: `${MAX_UPLOAD_BYTES / (1024 * 1024)} MB` }),
      );

    const processed = await processImage(buf); // magic-byte validate + EXIF strip + thumbnail
    const ext = EXT_BY_CONTENT_TYPE[processed.contentType] ?? "bin";
    const objectKey = `${randomUUID()}.${ext}`;

    // Both writes or neither: if the thumbnail write fails after the original
    // landed, remove the partial object so no orphaned blob accrues on disk.
    try {
      await this.write(objectKey, processed.body);
      await this.write(`${objectKey}${THUMB_SUFFIX}`, processed.thumbnail);
    } catch (e) {
      await this.delete(objectKey);
      throw e;
    }

    return {
      objectKey,
      sizeBytes: processed.body.length,
      contentType: processed.contentType,
      width: processed.width,
      height: processed.height,
    };
  }

  async get(objectKey: string): Promise<GetResult> {
    const body = decryptBuffer(await readFile(this.pathFor(objectKey)));
    const contentType = objectKey.endsWith(THUMB_SUFFIX)
      ? "image/jpeg"
      : contentTypeForKey(objectKey);
    return { body, contentType };
  }

  async delete(objectKey: string): Promise<void> {
    await this.safeUnlink(this.pathFor(objectKey));
    await this.safeUnlink(this.pathFor(`${objectKey}${THUMB_SUFFIX}`));
  }

  private async safeUnlink(p: string): Promise<void> {
    try {
      await unlink(p);
    } catch {
      // already gone — delete is idempotent
    }
  }

  /** Local FS has no signed URLs; the app route (auth-guarded) IS the access path. */
  async presign(objectKey: string): Promise<string> {
    return `/attachments/${objectKey}`;
  }
}

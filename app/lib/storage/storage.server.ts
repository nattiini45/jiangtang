/**
 * Storage seam (FROZEN interface). v1 implementation = encrypted local FS with
 * sharp thumbnails + EXIF/GPS strip + magic-byte validation. Only the
 * object key is stored in Postgres — never the bytes.
 */

export type StorageCategory =
  "room" | "control_panel" | "connection_panel" | "equipment" | "ticket";

export interface PutInput {
  body: Buffer | Uint8Array;
  contentType: string;
  category: StorageCategory;
  filename: string;
}

export interface StoredObject {
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  width?: number;
  height?: number;
}

export interface GetResult {
  body: Buffer;
  contentType: string;
}

export interface StorageProvider {
  /** Validate + (for images) strip EXIF + thumbnail, then persist. Returns the key. */
  put(input: PutInput): Promise<StoredObject>;
  get(objectKey: string): Promise<GetResult>;
  /** A time-limited URL (or app route) to fetch the object. */
  presign(objectKey: string, expiresInSeconds?: number): Promise<string>;
  delete(objectKey: string): Promise<void>;
}

class NotImplementedStorageProvider implements StorageProvider {
  private fail(): never {
    throw new Error(
      "StorageProvider is not implemented yet (the filesystem provider is installed by storage.boot.server.ts).",
    );
  }
  put(): Promise<StoredObject> {
    return this.fail();
  }
  get(): Promise<GetResult> {
    return this.fail();
  }
  presign(): Promise<string> {
    return this.fail();
  }
  delete(): Promise<void> {
    return this.fail();
  }
}

let provider: StorageProvider = new NotImplementedStorageProvider();

/** The storage boot module calls this to install the real provider. */
export function setStorageProvider(p: StorageProvider): void {
  provider = p;
}

export function getStorage(): StorageProvider {
  return provider;
}

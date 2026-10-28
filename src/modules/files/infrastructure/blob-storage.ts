export interface StoredBlob {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

/** Private immutable bytes. Storage keys never come from HTTP input. */
export abstract class BlobStorage {
  abstract put(ownerId: number, content: Buffer): Promise<StoredBlob>;
  abstract read(ownerId: number, blob: StoredBlob): Promise<Buffer>;
}

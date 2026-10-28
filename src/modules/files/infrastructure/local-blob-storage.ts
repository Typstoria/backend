import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import { BlobStorage, StoredBlob } from './blob-storage';

@Injectable()
export class LocalBlobStorage extends BlobStorage {
  private readonly root: string;

  constructor(config: AppConfigService) {
    super();
    this.root = resolve(config.blobStoragePath);
  }

  async put(ownerId: number, content: Buffer): Promise<StoredBlob> {
    this.assertOwner(ownerId);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const blob = { storageKey: `${ownerId}/${sha256}`, sha256, sizeBytes: content.length };
    const directory = join(this.root, String(ownerId));
    const temporary = join(directory, `.staging-${randomUUID()}`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      try {
        // Atomic publication without overwriting an existing immutable object.
        await link(temporary, join(this.root, blob.storageKey));
      } catch (error) {
        if (!this.hasCode(error, 'EEXIST')) throw error;
        await this.read(ownerId, blob);
      }
      return blob;
    } catch {
      throw this.unavailable();
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async read(ownerId: number, blob: StoredBlob): Promise<Buffer> {
    this.assertOwner(ownerId);
    // Enforce tenant binding and reject traversal even if metadata is malformed.
    if (!/^[a-f0-9]{64}$/.test(blob.sha256) || blob.storageKey !== `${ownerId}/${blob.sha256}`)
      throw this.unavailable();
    try {
      const content = await readFile(join(this.root, blob.storageKey));
      if (
        content.length !== blob.sizeBytes ||
        createHash('sha256').update(content).digest('hex') !== blob.sha256
      )
        throw this.unavailable();
      return content;
    } catch {
      throw this.unavailable();
    }
  }

  private assertOwner(ownerId: number): void {
    if (!Number.isInteger(ownerId) || ownerId < 1 || ownerId > 2147483647) throw this.unavailable();
  }

  private hasCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'STORAGE_UNAVAILABLE',
      message: 'File storage is unavailable',
    });
  }
}

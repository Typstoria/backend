import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config.service';
import { LocalBlobStorage } from './local-blob-storage';

describe('private local immutable storage', () => {
  let root: string;
  let storage: LocalBlobStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-blobs-'));
    storage = new LocalBlobStorage({ blobStoragePath: root } as AppConfigService);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('publishes concurrent writes atomically, deduplicates within a tenant and preserves UTF-8 bytes', async () => {
    const content = Buffer.from('= Документ\nПривіт!');
    const results = await Promise.all([1, 2, 3].map(() => storage.put(1, content)));
    expect(results[1]).toEqual(results[0]);
    expect(await storage.read(1, results[0]!)).toEqual(content);
    expect(await readdir(join(root, '1'))).toEqual([results[0]!.sha256]);
    const other = await storage.put(2, content);
    expect(other.storageKey).not.toEqual(results[0]!.storageKey);
    expect(await readFile(join(root, other.storageKey))).toEqual(content);
    await expect(storage.read(2, results[0]!)).rejects.toMatchObject({
      response: { code: 'STORAGE_UNAVAILABLE' },
    });
  });

  it('stores empty files and rejects missing or corrupt objects without leaking local paths', async () => {
    const blob = await storage.put(1, Buffer.alloc(0));
    expect(await storage.read(1, blob)).toEqual(Buffer.alloc(0));
    await writeFile(join(root, blob.storageKey), 'corrupted');
    await expect(storage.read(1, blob)).rejects.toThrow('File storage is unavailable');
    await expect(storage.put(1, Buffer.alloc(0))).rejects.toThrow('File storage is unavailable');
    await rm(join(root, blob.storageKey));
    await expect(storage.read(1, blob)).rejects.toThrow('File storage is unavailable');
    await expect(storage.read(1, { ...blob, storageKey: '../private' })).rejects.toThrow(
      'File storage is unavailable',
    );
    await expect(storage.put(-1, Buffer.alloc(0))).rejects.toThrow('File storage is unavailable');
  });
});

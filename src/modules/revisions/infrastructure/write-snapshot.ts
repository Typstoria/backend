import { In, type EntityManager } from 'typeorm';
import type { BlobStorage, StoredBlob } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { FileIdentity } from '../../files/infrastructure/persistence/entities/file-identity.entity';
import type { TextSnapshot } from '../../projects/domain/text-changes';
import { snapshotManifestHash } from '../domain/snapshot-manifest';
import { ProjectSnapshot } from './persistence/entities/project-snapshot.entity';
import { SnapshotFile } from './persistence/entities/snapshot-file.entity';

/** Publish immutable bytes before taking database locks. Unreferenced bytes can be collected later. */
export async function stageSnapshot(storage: BlobStorage, ownerId: number, draft: TextSnapshot) {
  const staged = new Map<string, StoredBlob>();
  for (const file of draft.files)
    if (file.content !== undefined && !staged.has(file.sha256))
      staged.set(file.sha256, await storage.put(ownerId, Buffer.from(file.content, 'utf8')));
  return staged;
}

/** Shared by manual saves and proposal candidates; callers own the transaction and authorization. */
export async function writeSnapshot(
  manager: EntityManager,
  ownerId: number,
  projectId: number,
  draft: TextSnapshot,
  staged: ReadonlyMap<string, StoredBlob>,
) {
  const blobIds = new Map<string, number>();
  if (staged.size) {
    await manager
      .createQueryBuilder()
      .insert()
      .into(Blob)
      .values(
        [...staged.values()]
          .sort((a, b) => a.sha256.localeCompare(b.sha256))
          .map((blob) => ({
            ...blob,
            ownerId,
            mediaType: 'text/plain; charset=utf-8',
          })),
      )
      .orIgnore()
      .execute();
    const blobs = await manager.findBy(Blob, { ownerId, sha256: In([...staged.keys()]) });
    for (const blob of blobs) blobIds.set(blob.sha256, blob.id);
  }
  const createdFiles: { fileId: number; path: string }[] = [];
  for (const file of draft.files) {
    if (file.fileId < 0) {
      const created = await manager.save(FileIdentity, manager.create(FileIdentity, { projectId }));
      if (draft.mainFileId === file.fileId) draft.mainFileId = created.id;
      file.fileId = created.id;
      createdFiles.push({ fileId: created.id, path: file.path });
    }
    if (file.content !== undefined) file.blobId = blobIds.get(file.sha256)!;
  }
  const snapshot = await manager.save(
    ProjectSnapshot,
    manager.create(ProjectSnapshot, {
      projectId,
      mainFileId: draft.mainFileId,
      contextText: draft.contextText,
      directories: draft.directories ?? [],
      manifestHash: snapshotManifestHash(draft),
    }),
  );
  await manager.insert(
    SnapshotFile,
    draft.files.map((file) => ({
      snapshotId: snapshot.id,
      fileId: file.fileId,
      projectId,
      ownerId,
      normalizedPath: file.path,
      blobId: file.blobId!,
      contentKind: file.contentKind,
      mediaType: file.mediaType,
    })),
  );
  return { snapshot, createdFiles };
}

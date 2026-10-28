import type { EntityManager } from 'typeorm';
import type { DraftFile } from '../../domain/text-changes';
import { Blob } from '../../../files/infrastructure/persistence/entities/blob.entity';
import { SnapshotFile } from '../../../revisions/infrastructure/persistence/entities/snapshot-file.entity';

export function readSnapshotFiles(
  manager: EntityManager,
  projectId: number,
  snapshotId: number,
  ownerId: number,
): Promise<DraftFile[]> {
  return manager
    .createQueryBuilder(SnapshotFile, 'file')
    .innerJoin(Blob, 'blob', 'blob.id = file.blobId AND blob.ownerId = file.ownerId')
    .select('file.fileId', 'fileId')
    .addSelect('file.normalizedPath', 'path')
    .addSelect('file.blobId', 'blobId')
    .addSelect('file.contentKind', 'contentKind')
    .addSelect('blob.sha256', 'sha256')
    .addSelect('blob.sizeBytes', 'sizeBytes')
    .addSelect('file.mediaType', 'mediaType')
    .where(
      'file.projectId = :projectId AND file.snapshotId = :snapshotId AND file.ownerId = :ownerId',
      { projectId, snapshotId, ownerId },
    )
    .orderBy('file.normalizedPath', 'ASC')
    .getRawMany<DraftFile>();
}

import { GitRevisionMapping } from '../../history/infrastructure/persistence/entities/git-revision-mapping.entity';
import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { UserActor } from '../../../common/actor/actor';
import { BlobStorage, StoredBlob } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { FileIdentity } from '../../files/infrastructure/persistence/entities/file-identity.entity';
import { snapshotManifestHash } from '../../revisions/domain/snapshot-manifest';
import { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { ProjectRevision } from '../../revisions/infrastructure/persistence/entities/project-revision.entity';
import { SnapshotFile } from '../../revisions/infrastructure/persistence/entities/snapshot-file.entity';
import { readSnapshotFiles } from '../infrastructure/persistence/read-snapshot-files';
import { AuditEvent } from '../../audit/infrastructure/persistence/entities/audit-event.entity';
import { Project } from '../infrastructure/persistence/entities/project.entity';
import { IdempotencyRecord } from '../infrastructure/persistence/entities/idempotency-record.entity';
import { applyTextChanges } from '../domain/text-changes';
import {
  checkIdempotencyPayload,
  mutationPayloadHash,
  requireIdempotencyKey,
} from '../domain/idempotency';
import type { ProjectChangesDto, ProjectChangesResultDto } from '../http/project-changes.dto';
import { ProjectsService } from './projects.service';
import { ProjectUploadsService } from './project-uploads.service';

@Injectable()
export class ProjectChangesService {
  constructor(
    private readonly database: DataSource,
    private readonly storage: BlobStorage,
    private readonly projects: ProjectsService,
    private readonly uploads: ProjectUploadsService,
  ) {}

  async save(
    actor: UserActor,
    projectId: number,
    input: ProjectChangesDto,
    key: string | undefined,
    requestId: string,
  ): Promise<ProjectChangesResultDto> {
    const project = await this.projects.ownedProject(this.database.manager, actor, projectId);
    key = requireIdempotencyKey(key);
    const operation = `projects:${projectId}:changes`;
    const payloadHash = mutationPayloadHash(input);
    const lookup = { sessionId: actor.credentialId, operation, key };
    const replay = (record: IdempotencyRecord): ProjectChangesResultDto => {
      checkIdempotencyPayload(record.payloadHash, payloadHash);
      return { ...record.result, createdFiles: record.result.createdFiles ?? [] };
    };
    const previous = await this.database.manager.findOneBy(IdempotencyRecord, lookup);
    if (previous) return replay(previous);
    this.checkBase(project, input.baseRevisionId);
    const revision = await this.database.manager.findOneByOrFail(ProjectRevision, {
      id: input.baseRevisionId,
      projectId,
    });
    const base = await this.database.manager.findOneByOrFail(ProjectSnapshot, {
      id: revision.snapshotId,
      projectId,
    });
    const files = await readSnapshotFiles(this.database.manager, projectId, base.id, actor.userId);
    const uploadIds = input.operations.flatMap((operation) =>
      'uploadId' in operation ? [operation.uploadId] : [],
    );
    const resources = await this.uploads.resources(
      this.database.manager,
      actor,
      projectId,
      uploadIds,
    );
    const draft = applyTextChanges(
      { mainFileId: base.mainFileId, contextText: base.contextText, files },
      input.operations,
      resources,
    );
    const usedUploads = [
      ...new Set(
        draft.files.flatMap((file) => (file.uploadId === undefined ? [] : [file.uploadId])),
      ),
    ];

    const unchanged = snapshotManifestHash(draft) === base.manifestHash;

    // Structural checks precede I/O. Immutable objects are published before the short DB transaction.
    // Concurrent saves/deletion are checked again after acquiring the project row lock.
    const staged = new Map<string, StoredBlob>();
    for (const file of draft.files) {
      if (!unchanged && file.content !== undefined && !staged.has(file.sha256))
        staged.set(
          file.sha256,
          await this.storage.put(actor.userId, Buffer.from(file.content, 'utf8')),
        );
    }

    return this.database.transaction(async (manager) => {
      const current = await this.projects.ownedProject(manager, actor, projectId, true);
      const completed = await manager.findOneBy(IdempotencyRecord, lookup);
      if (completed) return replay(completed);
      this.checkBase(current, input.baseRevisionId);
      await this.uploads.resources(manager, actor, projectId, usedUploads);

      if (unchanged) {
        const mapping = await manager.findOneBy(GitRevisionMapping, {
          revisionId: revision.id,
          projectId,
        });
        const result: ProjectChangesResultDto = {
          projectId,
          revisionId: revision.id,
          revisionNumber: revision.number,
          mainFileId: base.mainFileId,
          manifestHash: base.manifestHash,
          historySyncStatus: mapping?.status ?? 'pending',
          createdFiles: [],
        };
        await manager.insert(IdempotencyRecord, { ...lookup, projectId, payloadHash, result });
        return result;
      }

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
                ownerId: actor.userId,
                mediaType: 'text/plain; charset=utf-8',
              })),
          )
          .orIgnore()
          .execute();
        const blobs = await manager.findBy(Blob, {
          ownerId: actor.userId,
          sha256: In([...staged.keys()]),
        });
        for (const blob of blobs) blobIds.set(blob.sha256, blob.id);
      }
      const createdFiles: ProjectChangesResultDto['createdFiles'] = [];
      for (const file of draft.files) {
        if (file.fileId < 0) {
          const created = await manager.save(
            FileIdentity,
            manager.create(FileIdentity, { projectId }),
          );
          if (draft.mainFileId === file.fileId) draft.mainFileId = created.id;
          file.fileId = created.id;
          createdFiles.push({ fileId: created.id, path: file.path });
        }
        if (file.content !== undefined) file.blobId = blobIds.get(file.sha256)!;
      }
      const manifestHash = snapshotManifestHash(draft);
      const snapshot = await manager.save(
        ProjectSnapshot,
        manager.create(ProjectSnapshot, {
          projectId,
          mainFileId: draft.mainFileId,
          contextText: draft.contextText,
          manifestHash,
        }),
      );
      await manager.insert(
        SnapshotFile,
        draft.files.map((file) => ({
          snapshotId: snapshot.id,
          fileId: file.fileId,
          projectId,
          ownerId: actor.userId,
          normalizedPath: file.path,
          blobId: file.blobId!,
          contentKind: file.contentKind,
          mediaType: file.mediaType,
        })),
      );
      const accepted = await manager.save(
        ProjectRevision,
        manager.create(ProjectRevision, {
          projectId,
          number: current.nextRevisionNumber,
          parentRevisionId: input.baseRevisionId,
          snapshotId: snapshot.id,
          actorId: actor.userId,
          channel: actor.channel,
          operation: 'save',
          summary: input.summary ?? 'Updated project',
        }),
      );
      await manager.update(
        Project,
        { id: projectId },
        { currentRevisionId: accepted.id, nextRevisionNumber: accepted.number + 1 },
      );
      await manager.insert(AuditEvent, {
        projectId,
        actorId: actor.userId,
        credentialId: actor.credentialId,
        channel: actor.channel,
        action: 'project.saved',
        requestId,
      });
      await manager.insert(GitRevisionMapping, { revisionId: accepted.id, projectId });
      const result: ProjectChangesResultDto = {
        projectId,
        revisionId: accepted.id,
        revisionNumber: accepted.number,
        mainFileId: draft.mainFileId,
        manifestHash,
        historySyncStatus: 'pending',
        createdFiles,
      };
      await manager.insert(IdempotencyRecord, { ...lookup, projectId, payloadHash, result });
      return result;
    });
  }

  private checkBase(project: Project, baseRevisionId: number): void {
    if (project.currentRevisionId !== baseRevisionId)
      throw new ConflictException({
        code: 'REVISION_CONFLICT',
        message: 'The project changed after this revision was read.',
        details: { currentRevisionId: project.currentRevisionId },
      });
  }
}

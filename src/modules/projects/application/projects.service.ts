import { GitRevisionMapping } from '../../history/infrastructure/persistence/entities/git-revision-mapping.entity';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, IsNull, LessThan } from 'typeorm';
import type { UserActor } from '../../../common/actor/actor';
import { BlobStorage } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { FileIdentity } from '../../files/infrastructure/persistence/entities/file-identity.entity';
import { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { SnapshotFile } from '../../revisions/infrastructure/persistence/entities/snapshot-file.entity';
import { ProjectRevision } from '../../revisions/infrastructure/persistence/entities/project-revision.entity';
import { readSnapshotFiles } from '../infrastructure/persistence/read-snapshot-files';
import { snapshotManifestHash } from '../../revisions/domain/snapshot-manifest';
import { AuditEvent } from '../../audit/infrastructure/persistence/entities/audit-event.entity';
import { Project } from '../infrastructure/persistence/entities/project.entity';
import { IdempotencyRecord } from '../infrastructure/persistence/entities/idempotency-record.entity';
import {
  checkIdempotencyPayload,
  mutationPayloadHash,
  requireIdempotencyKey,
} from '../domain/idempotency';
import type {
  ProjectCreatedDto,
  ProjectDto,
  ProjectListDto,
  ProjectStateDto,
  ProjectTextFileDto,
} from '../http/projects.dto';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly database: DataSource,
    private readonly storage: BlobStorage,
  ) {}

  async create(
    actor: UserActor,
    title: string,
    key: string | undefined,
    requestId: string,
  ): Promise<ProjectCreatedDto> {
    this.requireWebActor(actor);
    key = requireIdempotencyKey(key);
    const payloadHash = mutationPayloadHash({ title });

    return this.database.transaction(async (manager) => {
      // Serialize just this session/key, including simultaneous retries before a result exists.
      // Hash collisions only serialize unrelated requests; the unique key still scopes results exactly.
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `projects:create:${actor.credentialId}:${key}`,
      ]);
      const previous = await manager.findOneBy(IdempotencyRecord, {
        sessionId: actor.credentialId,
        operation: 'projects.create',
        key,
      });
      if (previous) {
        await this.ownedProject(manager, actor, previous.projectId);
        checkIdempotencyPayload(previous.payloadHash, payloadHash);
        return previous.result;
      }

      // Publish the fixed, empty initial source before inserting any reference to its bytes.
      // A rolled-back transaction can leave an unreferenced immutable object, never a partial project.
      const stored = await this.storage.put(actor.userId, Buffer.alloc(0));
      await manager
        .createQueryBuilder()
        .insert()
        .into(Blob)
        .values({
          ownerId: actor.userId,
          ...stored,
          mediaType: 'text/plain; charset=utf-8',
        })
        .orIgnore()
        .execute();
      const blob = await manager.findOneByOrFail(Blob, {
        ownerId: actor.userId,
        sha256: stored.sha256,
      });

      // Reserve the ID so current_revision_id is NOT NULL even during bootstrap.
      // Deferred composite FKs validate the completed graph at commit.
      const rows: Array<{ id: number }> = await manager.query(
        "SELECT nextval(pg_get_serial_sequence('project_revisions', 'id'))::integer AS id",
      );
      const revisionId = rows[0]!.id;
      const project = await manager.save(
        Project,
        manager.create(Project, {
          ownerId: actor.userId,
          title,
          currentRevisionId: revisionId,
        }),
      );
      const file = await manager.save(
        FileIdentity,
        manager.create(FileIdentity, { projectId: project.id }),
      );
      const manifestHash = snapshotManifestHash({
        mainFileId: file.id,
        contextText: '',
        files: [
          {
            fileId: file.id,
            path: 'main.typ',
            contentKind: 'text',
            sha256: blob.sha256,
            sizeBytes: blob.sizeBytes,
            mediaType: blob.mediaType,
          },
        ],
      });
      const snapshot = await manager.save(
        ProjectSnapshot,
        manager.create(ProjectSnapshot, {
          projectId: project.id,
          mainFileId: file.id,
          contextText: '',
          manifestHash,
        }),
      );
      await manager.insert(SnapshotFile, {
        snapshotId: snapshot.id,
        projectId: project.id,
        ownerId: actor.userId,
        fileId: file.id,
        normalizedPath: 'main.typ',
        blobId: blob.id,
        contentKind: 'text',
        mediaType: 'text/plain; charset=utf-8',
      });
      // Explicit columns are required: TypeORM otherwise omits generated IDs on INSERT.
      await manager
        .createQueryBuilder()
        .insert()
        .into(ProjectRevision, [
          'id',
          'projectId',
          'number',
          'parentRevisionId',
          'snapshotId',
          'actorId',
          'channel',
          'operation',
          'summary',
        ])
        .values({
          id: revisionId,
          projectId: project.id,
          number: 1,
          parentRevisionId: null,
          snapshotId: snapshot.id,
          actorId: actor.userId,
          channel: actor.channel,
          operation: 'create',
          summary: 'Created project',
        })
        .execute();
      await manager.insert(GitRevisionMapping, { revisionId, projectId: project.id });
      await manager.insert(AuditEvent, {
        projectId: project.id,
        actorId: actor.userId,
        credentialId: actor.credentialId,
        channel: actor.channel,
        action: 'project.created',
        requestId,
      });
      const result: ProjectCreatedDto = {
        projectId: project.id,
        revisionId,
        revisionNumber: 1,
        mainFileId: file.id,
        manifestHash,
        historySyncStatus: 'pending',
      };
      await manager.insert(IdempotencyRecord, {
        sessionId: actor.credentialId,
        operation: 'projects.create',
        key,
        payloadHash,
        projectId: project.id,
        result,
      });
      return result;
    });
  }

  async get(actor: UserActor, projectId: number): Promise<ProjectDto> {
    return this.projectDto(await this.ownedProject(this.database.manager, actor, projectId));
  }

  async list(actor: UserActor, limit: number, cursor?: number): Promise<ProjectListDto> {
    this.requireWebActor(actor);
    const projects = await this.database.manager.find(Project, {
      where: {
        ownerId: actor.userId,
        deletedAt: IsNull(),
        ...(cursor === undefined ? {} : { id: LessThan(cursor) }),
      },
      order: { id: 'DESC' },
      take: limit + 1,
    });
    const items = projects.slice(0, limit).map((project) => this.projectDto(project));
    return { items, nextCursor: projects.length > limit ? items.at(-1)!.id : null };
  }

  async rename(
    actor: UserActor,
    projectId: number,
    title: string,
    requestId: string,
  ): Promise<ProjectDto> {
    return this.database.transaction(async (manager) => {
      const project = await this.ownedProject(manager, actor, projectId, true);
      if (project.title === title) return this.projectDto(project);
      project.title = title;
      const updated = await manager.save(Project, project);
      await manager.insert(AuditEvent, {
        projectId,
        actorId: actor.userId,
        credentialId: actor.credentialId,
        channel: actor.channel,
        action: 'project.renamed',
        requestId,
      });
      return this.projectDto(updated);
    });
  }

  async delete(actor: UserActor, projectId: number, requestId: string): Promise<void> {
    await this.database.transaction(async (manager) => {
      const project = await this.ownedProject(manager, actor, projectId, true);
      project.deletedAt = new Date();
      await manager.save(Project, project);
      await manager.insert(AuditEvent, {
        projectId,
        actorId: actor.userId,
        credentialId: actor.credentialId,
        channel: actor.channel,
        action: 'project.deleted',
        requestId,
      });
    });
  }

  async state(actor: UserActor, projectId: number, revisionId?: number): Promise<ProjectStateDto> {
    const project = await this.ownedProject(this.database.manager, actor, projectId);
    const revision = await this.database.manager.findOneBy(ProjectRevision, {
      id: revisionId ?? project.currentRevisionId,
      projectId,
    });
    if (!revision) throw new NotFoundException('Revision not found');
    const snapshot = await this.database.manager.findOneByOrFail(ProjectSnapshot, {
      id: revision.snapshotId,
      projectId,
    });
    const files = await readSnapshotFiles(
      this.database.manager,
      projectId,
      snapshot.id,
      actor.userId,
    );
    const mapping = await this.database.manager.findOneBy(GitRevisionMapping, {
      revisionId: revision.id,
      projectId,
    });
    const tree = files.map((file) => ({
      fileId: file.fileId,
      path: file.path,
      contentKind: file.contentKind,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mediaType: file.mediaType,
    }));
    return {
      project: this.projectDto(project),
      revision: {
        id: revision.id,
        number: revision.number,
        historySyncStatus: mapping?.status ?? 'pending',
        commitSha: mapping?.status === 'ready' ? mapping.commitSha : null,
        parentRevisionId: revision.parentRevisionId,
        manifestHash: snapshot.manifestHash,
        createdAt: revision.createdAt.toISOString(),
      },
      mainFileId: snapshot.mainFileId,
      contextText: snapshot.contextText,
      tree,
    };
  }

  async readTextFile(
    actor: UserActor,
    projectId: number,
    fileId: number,
    revisionId?: number,
  ): Promise<ProjectTextFileDto> {
    const { file, blob, revision } = await this.fileVersion(actor, projectId, fileId, revisionId);
    if (file.contentKind !== 'text')
      throw new BadRequestException('This endpoint reads text files only');
    const bytes = await this.storage.read(actor.userId, blob);
    return {
      fileId,
      path: file.normalizedPath,
      revisionId: revision.id,
      contentKind: file.contentKind,
      sha256: blob.sha256,
      sizeBytes: blob.sizeBytes,
      mediaType: file.mediaType,
      content: bytes.toString('utf8'),
    };
  }

  async downloadFile(
    actor: UserActor,
    projectId: number,
    fileId: number,
    revisionId?: number,
  ): Promise<{ filename: string; mediaType: string; content: Buffer }> {
    const { file, blob } = await this.fileVersion(actor, projectId, fileId, revisionId);
    return {
      filename: file.normalizedPath.split('/').at(-1)!,
      mediaType: file.mediaType,
      content: await this.storage.read(actor.userId, blob),
    };
  }

  private async fileVersion(
    actor: UserActor,
    projectId: number,
    fileId: number,
    revisionId?: number,
  ) {
    const project = await this.ownedProject(this.database.manager, actor, projectId);
    const revision = await this.database.manager.findOneBy(ProjectRevision, {
      id: revisionId ?? project.currentRevisionId,
      projectId,
    });
    if (!revision) throw new NotFoundException('Revision not found');
    const file = await this.database.manager.findOneBy(SnapshotFile, {
      snapshotId: revision.snapshotId,
      projectId,
      fileId,
    });
    if (!file) throw new NotFoundException('File not found');
    const blob = await this.database
      .getRepository(Blob)
      .createQueryBuilder('blob')
      .addSelect('blob.storageKey')
      .where('blob.id = :id AND blob.ownerId = :ownerId', {
        id: file.blobId,
        ownerId: actor.userId,
      })
      .getOneOrFail();
    return { file, blob, revision };
  }

  async ownedProject(
    manager: EntityManager,
    actor: UserActor,
    projectId: number,
    lock = false,
  ): Promise<Project> {
    this.requireWebActor(actor);
    const project = await manager.findOne(Project, {
      where: { id: projectId, ownerId: actor.userId, deletedAt: IsNull() },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  private requireWebActor(actor: UserActor): void {
    if (actor.channel !== 'web') throw new ForbiddenException('A web session is required');
  }

  private projectDto(project: Project): ProjectDto {
    return {
      id: project.id,
      title: project.title,
      currentRevisionId: project.currentRevisionId,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }
}

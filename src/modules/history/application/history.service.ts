import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import type { UserActor } from '../../../common/actor/actor';
import { AuditEvent } from '../../audit/infrastructure/persistence/entities/audit-event.entity';
import { ProjectsService } from '../../projects/application/projects.service';
import {
  checkIdempotencyPayload,
  mutationPayloadHash,
  requireIdempotencyKey,
} from '../../projects/domain/idempotency';
import { Project } from '../../projects/infrastructure/persistence/entities/project.entity';
import { IdempotencyRecord } from '../../projects/infrastructure/persistence/entities/idempotency-record.entity';
import { ProjectRevision } from '../../revisions/infrastructure/persistence/entities/project-revision.entity';
import { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { GitRevisionMapping } from '../infrastructure/persistence/entities/git-revision-mapping.entity';
import {
  HistoryRetryDto,
  ListRevisionsQueryDto,
  RestoredRevisionDto,
  RestoreRevisionDto,
  RevisionDetailsDto,
  RevisionListDto,
} from '../http/history.dto';

@Injectable()
export class HistoryService {
  constructor(
    private readonly database: DataSource,
    private readonly projects: ProjectsService,
  ) {}

  async list(
    actor: UserActor,
    projectId: number,
    query: ListRevisionsQueryDto,
  ): Promise<RevisionListDto> {
    const project = await this.projects.ownedProject(this.database.manager, actor, projectId);
    const builder = this.revisions(projectId)
      .orderBy('revision.number', 'DESC')
      .limit(query.limit + 1);
    if (query.cursor !== undefined)
      builder.andWhere('revision.number < :cursor', { cursor: query.cursor });
    const rows = await builder.getRawMany<RevisionDetailsDto>();
    const items = rows
      .slice(0, query.limit)
      .map((row) => ({ ...row, isCurrent: row.id === project.currentRevisionId }));
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.number : null };
  }

  async get(actor: UserActor, projectId: number, revisionId: number): Promise<RevisionDetailsDto> {
    const project = await this.projects.ownedProject(this.database.manager, actor, projectId);
    const row = await this.revisions(projectId)
      .andWhere('revision.id = :revisionId', { revisionId })
      .getRawOne<RevisionDetailsDto>();
    if (!row) throw new NotFoundException('Revision not found');
    return { ...row, isCurrent: row.id === project.currentRevisionId };
  }

  async restore(
    actor: UserActor,
    projectId: number,
    input: RestoreRevisionDto,
    key: string | undefined,
    requestId: string,
  ): Promise<RestoredRevisionDto> {
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    key = requireIdempotencyKey(key);
    const operation = `projects:${projectId}:restore`;
    const payloadHash = mutationPayloadHash(input);
    return this.database.transaction(async (manager) => {
      const project = await this.projects.ownedProject(manager, actor, projectId, true);
      const lookup = { sessionId: actor.credentialId, operation, key };
      const previous = await manager.findOneBy(IdempotencyRecord, lookup);
      if (previous) {
        checkIdempotencyPayload(previous.payloadHash, payloadHash);
        return {
          ...previous.result,
          restoredFromRevisionId: previous.result.restoredFromRevisionId!,
        };
      }
      if (project.currentRevisionId !== input.expectedCurrentRevisionId)
        throw new ConflictException({
          code: 'REVISION_CONFLICT',
          message: 'The project changed after this revision was read.',
          details: { currentRevisionId: project.currentRevisionId },
        });
      const target = await manager.findOneBy(ProjectRevision, {
        id: input.targetRevisionId,
        projectId,
      });
      if (!target) throw new NotFoundException('Revision not found');
      const snapshot = await manager.findOneByOrFail(ProjectSnapshot, {
        id: target.snapshotId,
        projectId,
      });
      // Reuse immutable content; restore keeps file IDs and creates a new accepted revision, never a reset.
      const accepted = await manager.save(
        ProjectRevision,
        manager.create(ProjectRevision, {
          projectId,
          number: project.nextRevisionNumber,
          parentRevisionId: project.currentRevisionId,
          snapshotId: snapshot.id,
          actorId: actor.userId,
          channel: actor.channel,
          operation: 'restore',
          summary: input.summary ?? `Restored revision ${target.number}`,
        }),
      );
      await manager.update(
        Project,
        { id: projectId },
        { currentRevisionId: accepted.id, nextRevisionNumber: accepted.number + 1 },
      );
      await manager.insert(GitRevisionMapping, { revisionId: accepted.id, projectId });
      await manager.insert(AuditEvent, {
        projectId,
        actorId: actor.userId,
        credentialId: actor.credentialId,
        channel: actor.channel,
        action: 'project.restored',
        requestId,
      });
      const result: RestoredRevisionDto = {
        projectId,
        revisionId: accepted.id,
        revisionNumber: accepted.number,
        mainFileId: snapshot.mainFileId,
        manifestHash: snapshot.manifestHash,
        historySyncStatus: 'pending',
        restoredFromRevisionId: target.id,
      };
      await manager.insert(IdempotencyRecord, { ...lookup, projectId, payloadHash, result });
      return result;
    });
  }

  async retry(actor: UserActor, projectId: number, requestId: string): Promise<HistoryRetryDto> {
    return this.database.transaction(async (manager) => {
      await this.projects.ownedProject(manager, actor, projectId, true);
      const reset = await manager.update(
        GitRevisionMapping,
        { projectId, status: 'failed', leaseToken: IsNull() },
        {
          status: 'pending',
          attempts: 0,
          errorCode: null,
          availableAt: new Date(),
          leaseExpiresAt: null,
        },
      );
      if (reset.affected) {
        await manager.insert(AuditEvent, {
          projectId,
          actorId: actor.userId,
          credentialId: actor.credentialId,
          channel: actor.channel,
          action: 'project.history.retry',
          requestId,
        });
      }
      return { projectId, resetCount: reset.affected ?? 0 };
    });
  }

  private revisions(projectId: number) {
    return this.database.manager
      .createQueryBuilder(ProjectRevision, 'revision')
      .innerJoin(
        ProjectSnapshot,
        'snapshot',
        'snapshot.id = revision.snapshotId AND snapshot.projectId = revision.projectId',
      )
      .leftJoin(
        GitRevisionMapping,
        'mapping',
        'mapping.revisionId = revision.id AND mapping.projectId = revision.projectId',
      )
      .select('revision.id', 'id')
      .addSelect('revision.projectId', 'projectId')
      .addSelect('revision.number', 'number')
      .addSelect('revision.parentRevisionId', 'parentRevisionId')
      .addSelect('revision.actorId', 'actorId')
      .addSelect('revision.channel', 'channel')
      .addSelect('revision.operation', 'operation')
      .addSelect('revision.summary', 'summary')
      .addSelect('snapshot.manifestHash', 'manifestHash')
      .addSelect(
        `to_char(revision.createdAt AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        'createdAt',
      )
      .addSelect("COALESCE(mapping.status, 'pending')", 'historySyncStatus')
      .addSelect(
        "CASE WHEN mapping.status = 'ready' THEN mapping.commitSha ELSE NULL END",
        'commitSha',
      )
      .addSelect('mapping.errorCode', 'historyErrorCode')
      .where('revision.projectId = :projectId', { projectId });
  }
}

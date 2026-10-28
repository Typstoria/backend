import {
  ConflictException,
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import type { UserActor } from '../../../common/actor/actor';
import { BlobStorage } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { StagedUpload } from '../../files/infrastructure/persistence/entities/staged-upload.entity';
import {
  MAX_ACTIVE_UPLOAD_BYTES,
  MAX_ACTIVE_UPLOADS,
  UPLOAD_TTL_MS,
  UploadedResource,
  validateResourceFile,
} from '../../files/domain/resource-file';
import { AuditEvent } from '../../audit/infrastructure/persistence/entities/audit-event.entity';
import type { UploadedDraftResource } from '../domain/text-changes';
import type { ProjectUploadDto } from '../http/project-uploads.dto';
import { ProjectsService } from './projects.service';

@Injectable()
export class ProjectUploadsService {
  constructor(
    private readonly database: DataSource,
    private readonly projects: ProjectsService,
    private readonly storage: BlobStorage,
  ) {}

  async upload(
    actor: UserActor,
    projectId: number,
    file: UploadedResource | undefined,
    requestId: string,
  ): Promise<ProjectUploadDto> {
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    const metadata = await validateResourceFile(file);
    const content = file!.buffer;
    await this.checkQuota(this.database.manager, actor.userId, content.length);
    const stored = await this.storage.put(actor.userId, content);
    return this.database.transaction(async (manager) => {
      // Serialize quota increments across this owner's projects, without locking the user row.
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `uploads:${actor.userId}`,
      ]);
      await this.projects.ownedProject(manager, actor, projectId, true);
      await this.checkQuota(manager, actor.userId, content.length);
      await manager
        .createQueryBuilder()
        .insert()
        .into(Blob)
        .values({ ownerId: actor.userId, ...stored, mediaType: metadata.mediaType })
        .orIgnore()
        .execute();
      const blob = await manager.findOneByOrFail(Blob, {
        ownerId: actor.userId,
        sha256: stored.sha256,
      });
      const staged = await manager.save(
        StagedUpload,
        manager.create(StagedUpload, {
          ownerId: actor.userId,
          projectId,
          ...metadata,
          blobId: blob.id,
          expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
        }),
      );
      await manager.insert(AuditEvent, {
        projectId,
        actorId: actor.userId,
        credentialId: actor.credentialId,
        channel: actor.channel,
        action: 'project.uploaded',
        requestId,
      });
      return this.dto(manager, staged);
    });
  }

  async get(actor: UserActor, projectId: number, uploadId: number): Promise<ProjectUploadDto> {
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    const upload = await this.database.manager.findOneBy(StagedUpload, {
      id: uploadId,
      projectId,
      ownerId: actor.userId,
    });
    if (!upload) throw new NotFoundException('Upload not found');
    return this.dto(this.database.manager, upload);
  }

  async resources(
    manager: EntityManager,
    actor: UserActor,
    projectId: number,
    ids: readonly number[],
  ): Promise<Map<number, UploadedDraftResource>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const uploads = await manager.findBy(StagedUpload, {
      id: In(unique),
      projectId,
      ownerId: actor.userId,
    });
    if (uploads.length !== unique.length) throw new NotFoundException('Upload not found');
    for (const upload of uploads) {
      if (upload.expiresAt.getTime() <= Date.now())
        throw new ConflictException({
          code: 'UPLOAD_EXPIRED',
          message: 'Upload expired; upload the resource again',
        });
    }
    const blobs = await manager.findBy(Blob, {
      id: In(uploads.map((upload) => upload.blobId)),
      ownerId: actor.userId,
    });
    const byId = new Map(blobs.map((blob) => [blob.id, blob]));
    return new Map(
      uploads.map((upload) => {
        const blob = byId.get(upload.blobId)!;
        return [
          upload.id,
          {
            blobId: blob.id,
            sha256: blob.sha256,
            sizeBytes: blob.sizeBytes,
            mediaType: upload.mediaType,
          },
        ];
      }),
    );
  }

  private async dto(manager: EntityManager, upload: StagedUpload): Promise<ProjectUploadDto> {
    const blob = await manager.findOneByOrFail(Blob, {
      id: upload.blobId,
      ownerId: upload.ownerId,
    });
    return {
      uploadId: upload.id,
      filename: upload.filename,
      mediaType: upload.mediaType,
      sizeBytes: blob.sizeBytes,
      sha256: blob.sha256,
      expiresAt: upload.expiresAt.toISOString(),
      status: upload.expiresAt.getTime() <= Date.now() ? 'expired' : 'available',
    };
  }

  private async checkQuota(manager: EntityManager, ownerId: number, size: number): Promise<void> {
    const usage = await manager
      .createQueryBuilder(StagedUpload, 'upload')
      .innerJoin(Blob, 'blob', 'blob.id = upload.blobId AND blob.ownerId = upload.ownerId')
      .select('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(blob.sizeBytes), 0)', 'bytes')
      .where('upload.ownerId = :ownerId AND upload.expiresAt > :now', { ownerId, now: new Date() })
      .getRawOne<{ count: string; bytes: string }>();
    if (
      Number(usage!.count) >= MAX_ACTIVE_UPLOADS ||
      Number(usage!.bytes) + size > MAX_ACTIVE_UPLOAD_BYTES
    )
      throw new HttpException(
        {
          code: 'UPLOAD_QUOTA_EXCEEDED',
          message: 'Upload quota exceeded: 400 unexpired uploads or 256 MiB per owner',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }
}

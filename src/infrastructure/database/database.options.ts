import { GitRevisionMapping } from '../../modules/history/infrastructure/persistence/entities/git-revision-mapping.entity';
import { CompileJob } from '../../modules/compilation/infrastructure/persistence/entities/compile-job.entity';
import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import type { DatabaseEnvironment } from '../../config/environment';
import { User } from '../../modules/identity/infrastructure/persistence/entities/user.entity';
import { WebSession } from '../../modules/identity/infrastructure/persistence/entities/web-session.entity';
import { IdentityChallenge } from '../../modules/identity/infrastructure/persistence/entities/identity-challenge.entity';
import { Project } from '../../modules/projects/infrastructure/persistence/entities/project.entity';
import { IdempotencyRecord } from '../../modules/projects/infrastructure/persistence/entities/idempotency-record.entity';
import { Blob } from '../../modules/files/infrastructure/persistence/entities/blob.entity';
import { FileIdentity } from '../../modules/files/infrastructure/persistence/entities/file-identity.entity';
import { StagedUpload } from '../../modules/files/infrastructure/persistence/entities/staged-upload.entity';
import { ProjectSnapshot } from '../../modules/revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { SnapshotFile } from '../../modules/revisions/infrastructure/persistence/entities/snapshot-file.entity';
import { ProjectRevision } from '../../modules/revisions/infrastructure/persistence/entities/project-revision.entity';
import { AuditEvent } from '../../modules/audit/infrastructure/persistence/entities/audit-event.entity';

export function createDatabaseOptions(
  environment: DatabaseEnvironment,
): Extract<DataSourceOptions, { type: 'postgres' }> {
  return {
    type: 'postgres',
    url: environment.DATABASE_URL,
    entities: [
      User,
      WebSession,
      IdentityChallenge,
      Project,
      IdempotencyRecord,
      Blob,
      FileIdentity,
      StagedUpload,
      ProjectSnapshot,
      SnapshotFile,
      ProjectRevision,
      AuditEvent,
      CompileJob,
      GitRevisionMapping,
    ],
    migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
    migrationsTableName: 'typeorm_migrations',
    migrationsTransactionMode: 'all',
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: false,
    installExtensions: false,
    connectTimeoutMS: environment.DATABASE_CONNECT_TIMEOUT_MS,
    invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw' },
    extra: {
      max: environment.DATABASE_POOL_SIZE,
      query_timeout: environment.DATABASE_QUERY_TIMEOUT_MS,
      application_name: 'typstoria',
    },
  };
}

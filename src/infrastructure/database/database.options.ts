import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import type { Environment } from '../../config/environment';
import { User } from '../../modules/identity/infrastructure/persistence/entities/user.entity';

export function createDatabaseOptions(environment: Environment): DataSourceOptions {
  return {
    type: 'postgres',
    url: environment.DATABASE_URL,
    entities: [User],
    migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
    migrationsTableName: 'typeorm_migrations',
    migrationsTransactionMode: 'all',
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: false,
    uuidExtension: 'pgcrypto',
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

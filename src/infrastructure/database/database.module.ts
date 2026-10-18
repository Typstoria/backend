import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigService } from '../../config/app-config.service';
import { createDatabaseOptions } from './database.options';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        ...createDatabaseOptions(config.environment),
        retryAttempts: 1,
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}

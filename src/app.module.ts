import { Module } from '@nestjs/common';
import { ApiModule } from './api.module';
import { ConfigurationModule } from './config/configuration.module';
import { DatabaseModule } from './infrastructure/database/database.module';

@Module({ imports: [ConfigurationModule.forRoot(), DatabaseModule, ApiModule] })
export class AppModule {}

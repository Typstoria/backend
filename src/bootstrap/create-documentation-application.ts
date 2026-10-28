import { ApiModule } from '../api.module';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { configureApiRoutes } from './configure-api-routes';

// Preview still resolves injection tokens, but never constructs runtime providers.
@Global()
@Module({
  providers: [
    { provide: DataSource, useValue: {} },
    { provide: AppConfigService, useValue: {} },
  ],
  exports: [DataSource, AppConfigService],
})
class DocumentationDependencies {}

@Module({ imports: [DocumentationDependencies, ApiModule] })
class DocumentationModule {}

export async function createDocumentationApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(DocumentationModule, {
    preview: true,
    abortOnError: false,
    bodyParser: false,
    logger: false,
  });
  configureApiRoutes(app);
  return app;
}

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureApiRoutes } from './configure-api-routes';

export async function createDocumentationApplication(): Promise<INestApplication> {
  // Only this standalone exporter supplies a fallback. Preview mode never creates a connection.
  // Set it before importing AppModule: ConfigModule validates during module evaluation.
  process.env.DATABASE_URL ??= 'postgresql://openapi:openapi@127.0.0.1:1/openapi';
  // Exporting metadata needs no production credentials or mail provider.
  process.env.NODE_ENV = 'test';
  // Metadata-only placeholders: preview mode never constructs the Mailjet provider.
  process.env.MAIL_FROM = 'openapi@example.test';
  process.env.MAILJET_API_KEY = 'openapi-placeholder';
  process.env.MAILJET_SECRET_KEY = 'openapi-placeholder';
  const { AppModule } = await import('../app.module');
  const app = await NestFactory.create(AppModule, {
    preview: true,
    abortOnError: false,
    bodyParser: false,
    logger: false,
  });
  configureApiRoutes(app);
  return app;
}

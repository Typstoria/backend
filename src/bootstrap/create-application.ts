import { ConsoleLogger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { configureApplication } from './configure-application';

export async function createApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(new ConsoleLogger({ json: true }));
  configureApplication(app);
  app.enableShutdownHooks();
  return app;
}

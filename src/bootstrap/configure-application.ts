import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { HttpExceptionFilter } from '../common/errors/http-exception.filter';
import { requestContext } from '../common/http/request-context';
import { AppConfigService } from '../config/app-config.service';
import { configureApiRoutes } from './configure-api-routes';
import { setupSwagger } from './swagger';

export function configureApplication(app: INestApplication): void {
  const config = app.get(AppConfigService);

  app.use(requestContext);
  app.use(helmet());
  app.enableCsrfProtection({ trustedOrigins: config.corsOrigins });
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '1mb' }));
  app.enableCors({
    origin: config.corsOrigins,
    exposedHeaders: ['X-Request-Id'],
  });
  configureApiRoutes(app);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  if (config.swaggerEnabled) setupSwagger(app);
}

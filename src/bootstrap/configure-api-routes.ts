import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

/** Shared by the HTTP server and the offline OpenAPI exporter. */
export function configureApiRoutes(app: INestApplication): void {
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
}

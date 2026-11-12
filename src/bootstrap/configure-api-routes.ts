import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

/** Shared by the HTTP server and the offline OpenAPI exporter. */
export function configureApiRoutes(app: INestApplication): void {
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'mcp', method: RequestMethod.ALL },
      { path: 'mcp/artifacts/:projectId/:jobId/pdf', method: RequestMethod.GET },
      { path: '.well-known/oauth-protected-resource', method: RequestMethod.GET },
      { path: '.well-known/oauth-protected-resource/mcp', method: RequestMethod.GET },
      { path: '.well-known/oauth-authorization-server/oauth', method: RequestMethod.GET },
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
}

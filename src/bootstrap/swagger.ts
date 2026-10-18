import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/errors/error-response.dto';

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Typstoria API')
    .setDescription(
      'Backend foundation for Typstoria. Currently implemented: health checks. ' +
        'Business endpoints will appear as their modules are implemented.',
    )
    .setVersion('0.1.0')
    .build();

  return SwaggerModule.createDocument(app, config, { extraModels: [ErrorResponseDto] });
}

export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('docs', app, createOpenApiDocument(app), {
    jsonDocumentUrl: 'docs-json',
    customSiteTitle: 'Typstoria API',
    swaggerOptions: { persistAuthorization: false, displayRequestDuration: true },
  });
}

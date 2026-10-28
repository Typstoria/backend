import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/errors/error-response.dto';

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Typstoria API')
    .setDescription(
      'Typstoria API: accounts, Mailjet email confirmation, password recovery and private projects. ' +
        'POST /api/auth/login returns one accessToken. Paste it into Authorize; ' +
        'private requests use Authorization: Bearer <accessToken>. No CSRF or refresh tokens.',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'opaque',
        description: 'Paste accessToken from POST /api/auth/login, without the Bearer prefix.',
      },
      'bearer',
    )
    .build();

  return SwaggerModule.createDocument(app, config, { extraModels: [ErrorResponseDto] });
}

export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('docs', app, createOpenApiDocument(app), {
    jsonDocumentUrl: 'docs-json',
    customSiteTitle: 'Typstoria API',
    swaggerOptions: {
      persistAuthorization: false,
      displayRequestDuration: true,
    },
  });
}

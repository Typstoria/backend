import { DataSource } from 'typeorm';
import { createDocumentationApplication } from '../src/bootstrap/create-documentation-application';
import { createOpenApiDocument } from '../src/bootstrap/swagger';

describe('offline OpenAPI generation', () => {
  it('scans the real application without initializing TypeORM or listening on a port', async () => {
    process.env.DATABASE_URL = 'postgresql://openapi:openapi@127.0.0.1:1/openapi';
    const initialize = jest.spyOn(DataSource.prototype, 'initialize');
    const send = jest.spyOn(globalThis, 'fetch');
    try {
      const app = await createDocumentationApplication();
      try {
        const document = createOpenApiDocument(app);
        expect(document.paths['/health/ready']?.get?.responses['200']).toBeDefined();
        expect(document.components?.schemas?.ReadyHealthDto).toBeDefined();
        expect(document.paths['/api/auth/register']?.post?.responses['202']).toBeDefined();
        expect(document.paths['/api/auth/login']?.post?.responses['200']).toBeDefined();
        expect(document.paths['/api/auth/login']?.post?.responses['403']).toMatchObject({
          description: expect.stringContaining('EMAIL_NOT_VERIFIED'),
        });
        expect(document.paths['/api/auth/reset-password']?.post).toBeDefined();
        expect(document.paths['/api/auth/google']?.post?.responses['200']).toBeDefined();
        expect(document.paths['/api/auth/google']?.post?.responses['503']).toBeDefined();
        expect(document.paths['/api/auth/google']?.post?.security).toBeUndefined();
        expect(document.paths['/api/auth/google/link']?.post?.security).toEqual([{ bearer: [] }]);
        const createProject = document.paths['/api/projects']?.post;
        expect(createProject?.security).toEqual([{ bearer: [] }]);
        expect(createProject?.responses['201']).toMatchObject({
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ProjectCreatedDto' } },
          },
        });
        expect(createProject?.responses['409']).toBeDefined();
        expect(createProject?.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: true }),
          ]),
        );
        expect(document.paths['/api/projects/{projectId}/state']?.get).toBeDefined();
        const changes = document.paths['/api/projects/{projectId}/changes']?.post;
        const upload = document.paths['/api/projects/{projectId}/uploads']?.post;
        expect(upload?.security).toEqual([{ bearer: [] }]);
        expect(upload?.requestBody).toMatchObject({
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
              },
            },
          },
        });
        expect(upload?.responses['201']).toBeDefined();
        expect(upload?.responses['413']).toBeDefined();
        expect(upload?.responses['415']).toBeDefined();
        expect(upload?.responses['429']).toBeDefined();
        expect(
          document.paths['/api/projects/{projectId}/uploads/{uploadId}']?.get?.responses['200'],
        ).toBeDefined();
        expect(
          document.paths['/api/projects/{projectId}/files/{fileId}/download']?.get?.responses[
            '200'
          ],
        ).toMatchObject({
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        });
        expect(changes?.security).toEqual([{ bearer: [] }]);
        expect(changes?.responses['201']).toMatchObject({
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProjectChangesResultDto' },
            },
          },
        });
        expect(changes?.responses['409']).toBeDefined();
        expect(changes?.responses['422']).toBeDefined();
        expect(changes?.responses['413']).toBeDefined();
        expect(changes?.requestBody).toMatchObject({
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProjectChangesDto' },
              examples: {
                updateText: {
                  value: {
                    baseRevisionId: 1,
                    summary: 'Оновлено вступ документа',
                    operations: [
                      { type: 'updateText', fileId: 1, content: '= Документ\nОновлений вступ.' },
                    ],
                  },
                },
              },
            },
          },
        });
        expect(document.components?.schemas?.ProjectChangesDto).toMatchObject({
          properties: {
            baseRevisionId: { example: 1, maximum: 2147483647 },
            summary: { example: 'Оновлено вступ документа' },
          },
        });
        expect(changes?.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
          ]),
        );
        expect(document.components?.schemas?.ProjectChangesDto).toMatchObject({
          required: ['baseRevisionId', 'operations'],
          properties: {
            operations: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: {
                oneOf: expect.arrayContaining([{ $ref: '#/components/schemas/UpdateTextDto' }]),
                discriminator: { propertyName: 'type' },
              },
            },
          },
        });
        expect(document.components?.schemas?.UpdateTextDto).toMatchObject({
          required: expect.arrayContaining(['type', 'fileId', 'content']),
          properties: { type: { enum: ['updateText'] } },
        });
        const listProjects = document.paths['/api/projects']?.get;
        expect(listProjects?.security).toEqual([{ bearer: [] }]);
        expect(listProjects?.responses['200']).toMatchObject({
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ProjectListDto' } },
          },
        });
        expect(listProjects?.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              in: 'query',
              name: 'limit',
              required: false,
              schema: expect.objectContaining({ default: 20, maximum: 100 }),
            }),
            expect.objectContaining({ in: 'query', name: 'cursor', required: false }),
          ]),
        );
        expect(document.paths['/api/projects/{projectId}']?.delete?.responses['204']).toBeDefined();

        expect(document.components?.schemas?.ProjectStateDto).toMatchObject({
          properties: {
            tree: { type: 'array', items: { $ref: '#/components/schemas/ProjectFileDto' } },
          },
        });
        expect(document.components?.schemas?.CreateProjectDto).toMatchObject({
          required: ['title'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200, example: 'Дипломна робота' },
          },
        });
        expect(document.paths['/api/projects/{projectId}']?.get?.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'projectId',
              in: 'path',
              schema: expect.objectContaining({ example: 1 }),
            }),
          ]),
        );
        expect(document.components?.schemas?.TokenDto).toMatchObject({
          properties: { token: { example: 'A'.repeat(43) } },
        });
        expect(Object.keys(document.paths).some((path) => path.startsWith('/api/sessions'))).toBe(
          false,
        );
        expect(document.components?.schemas?.SessionDto).toBeUndefined();
        expect(document.components?.schemas?.CredentialsDto).toBeDefined();
        expect(document.components?.schemas?.UserDto).toMatchObject({
          properties: {
            id: { type: 'integer', format: 'int32', minimum: 1, maximum: 2147483647 },
          },
        });
        expect(document.components?.securitySchemes?.bearer).toMatchObject({
          type: 'http',
          scheme: 'bearer',
        });
        expect(document.paths['/api/projects/{projectId}/compilations']?.post).toMatchObject({
          security: [{ bearer: [] }],
          responses: {
            '202': {
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CompilationDto' } },
              },
            },
          },
        });
        expect(document.paths['/api/projects/{projectId}/compilations/{jobId}']?.get).toBeDefined();
        expect(document.paths['/api/projects/{projectId}/revisions']?.get?.security).toEqual([
          { bearer: [] },
        ]);
        expect(
          document.paths['/api/projects/{projectId}/revisions/{revisionId}']?.get,
        ).toBeDefined();
        expect(
          document.paths['/api/projects/{projectId}/revisions/{revisionId}/diff']?.get,
        ).toBeDefined();
        expect(
          document.paths['/api/projects/{projectId}/restore']?.post?.responses['201'],
        ).toBeDefined();
        expect(
          document.paths['/api/projects/{projectId}/history/retry']?.post?.responses['202'],
        ).toBeDefined();
        expect(document.components?.schemas?.RestoreRevisionDto).toMatchObject({
          required: ['targetRevisionId', 'expectedCurrentRevisionId'],
          properties: {
            targetRevisionId: { type: 'integer', example: 1 },
            expectedCurrentRevisionId: { type: 'integer', example: 1 },
          },
        });
        expect(
          document.paths['/api/projects/{projectId}/compilations/{jobId}/pdf']?.get?.responses[
            '200'
          ],
        ).toMatchObject({
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
        });
        expect(document.components?.schemas?.CreateCompilationDto).toMatchObject({
          required: ['revisionId'],
          properties: { revisionId: { example: 1, type: 'integer', maximum: 2147483647 } },
        });
        expect(document.components?.securitySchemes?.csrf).toBeUndefined();
        expect(document.components?.securitySchemes?.session).toBeUndefined();
        expect(document.paths['/api/auth/csrf']).toBeUndefined();
        expect(document.paths['/api/auth/login']?.post?.security).toBeUndefined();
        expect(document.paths['/api/auth/logout']?.post?.security).toEqual([{ bearer: [] }]);
        expect(initialize).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(app.getHttpServer().listening).toBe(false);
      } finally {
        await app.close();
      }
    } finally {
      initialize.mockRestore();
      send.mockRestore();
    }
  });
});

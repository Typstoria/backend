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

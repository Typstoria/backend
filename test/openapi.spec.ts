import { DataSource } from 'typeorm';
import { createDocumentationApplication } from '../src/bootstrap/create-documentation-application';
import { createOpenApiDocument } from '../src/bootstrap/swagger';

describe('offline OpenAPI generation', () => {
  it('scans the real application without initializing TypeORM or listening on a port', async () => {
    process.env.DATABASE_URL = 'postgresql://openapi:openapi@127.0.0.1:1/openapi';
    const initialize = jest.spyOn(DataSource.prototype, 'initialize');
    try {
      const app = await createDocumentationApplication();
      try {
        const document = createOpenApiDocument(app);
        expect(document.paths['/health/ready']?.get?.responses['200']).toBeDefined();
        expect(document.components?.schemas?.ReadyHealthDto).toBeDefined();
        expect(initialize).not.toHaveBeenCalled();
        expect(app.getHttpServer().listening).toBe(false);
      } finally {
        await app.close();
      }
    } finally {
      initialize.mockRestore();
    }
  });
});

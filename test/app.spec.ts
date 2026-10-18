import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureApplication } from '../src/bootstrap/configure-application';
import { ConfigurationModule } from '../src/config/configuration.module';
import { HealthModule } from '../src/modules/health/health.module';

class ValidationFixtureDto {
  @ApiProperty()
  @IsString()
  @MaxLength(20)
  title!: string;
}

@Controller('test-fixture')
class ValidationFixtureController {
  @Post()
  create(@Body() body: ValidationFixtureDto): ValidationFixtureDto {
    return body;
  }
}

describe('HTTP foundation', () => {
  let app: INestApplication;
  const database = { query: jest.fn() };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/typstoria_test';
    process.env.SWAGGER_ENABLED = 'true';
    process.env.CORS_ORIGINS = 'http://localhost:5173';

    const module = await Test.createTestingModule({
      imports: [ConfigurationModule, HealthModule],
      controllers: [ValidationFixtureController],
    })
      .useMocker((token) => (token === DataSource ? database : undefined))
      .compile();

    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => database.query.mockResolvedValue([{ '?column?': 1 }]));
  afterAll(async () => app?.close());

  it('serves liveness without querying PostgreSQL and returns a request ID', async () => {
    const result = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(result.body.status).toBe('ok');
    expect(result.headers['x-request-id']).toBeDefined();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('checks PostgreSQL readiness', async () => {
    const result = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(result.body.checks).toEqual({ database: 'up' });
    expect(database.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns a structured 503 when PostgreSQL becomes unavailable', async () => {
    database.query.mockRejectedValueOnce(new Error('private connection details'));
    const result = await request(app.getHttpServer())
      .get('/health/ready')
      .set('X-Request-Id', 'readiness-test')
      .expect(503);
    expect(result.body.error).toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      requestId: 'readiness-test',
    });
    expect(JSON.stringify(result.body)).not.toContain('private connection details');
  });

  it('serves Swagger UI and OpenAPI schemas for real endpoints', async () => {
    await request(app.getHttpServer()).get('/docs/').expect(200).expect('Content-Type', /html/);
    const result = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(result.body.info.title).toBe('Typstoria API');
    expect(result.body.paths['/health/ready'].get.responses['503']).toBeDefined();
    expect(result.body.components.schemas.ErrorResponseDto).toBeDefined();
  });

  it('wraps missing routes with the same request ID', async () => {
    const result = await request(app.getHttpServer())
      .get('/api/v1/missing')
      .set('X-Request-Id', 'missing-route-test')
      .expect(404);
    expect(result.body.error).toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      requestId: 'missing-route-test',
    });
  });

  it('validates DTOs and rejects unexpected fields', async () => {
    const result = await request(app.getHttpServer())
      .post('/api/v1/test-fixture')
      .send({ title: 'valid', ownerId: 'forged-owner' })
      .expect(400);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
    expect(result.body.error.details.messages).toContain('property ownerId should not exist');
  });

  it('handles malformed JSON without exposing parser internals', async () => {
    const result = await request(app.getHttpServer())
      .post('/api/v1/test-fixture')
      .set('Content-Type', 'application/json')
      .send('{"title":')
      .expect(400);
    expect(result.body.error.code).toBe('BAD_REQUEST');
    expect(result.body.error.requestId).toBeDefined();
  });

  it('rejects oversized bodies', async () => {
    const result = await request(app.getHttpServer())
      .post('/api/v1/test-fixture')
      .send({ title: 'x'.repeat(1024 * 1024) })
      .expect(413);
    expect(result.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sets CORS only for configured origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/health/live')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const other = await request(app.getHttpServer())
      .get('/health/live')
      .set('Origin', 'https://untrusted.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

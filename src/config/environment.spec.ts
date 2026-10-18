import { validateEnvironment } from './environment';

const base = { DATABASE_URL: 'postgresql://user:secret@127.0.0.1:5432/typstoria' };

describe('environment validation', () => {
  it('parses port, explicit booleans and multiple CORS origins', () => {
    expect(
      validateEnvironment({
        ...base,
        PORT: '4000',
        SWAGGER_ENABLED: 'false',
        CORS_ORIGINS: 'http://localhost:5173, https://typstoria.example',
      }),
    ).toMatchObject({
      PORT: 4000,
      SWAGGER_ENABLED: false,
      CORS_ORIGINS: ['http://localhost:5173', 'https://typstoria.example'],
    });
  });

  it('disables Swagger by default in production', () => {
    expect(validateEnvironment({ ...base, NODE_ENV: 'production' }).SWAGGER_ENABLED).toBe(false);
  });

  it.each([
    { PORT: '0' },
    { PORT: 'invalid' },
    { SWAGGER_ENABLED: 'yes' },
    { DATABASE_URL: 'https://example.com' },
    { DATABASE_POOL_SIZE: '-1' },
    { CORS_ORIGINS: '*' },
    { CORS_ORIGINS: 'https://example.com/path' },
    { CORS_ORIGINS: 'https://user:password@example.com' },
  ])('rejects invalid configuration: %j', (invalid) => {
    expect(() => validateEnvironment({ ...base, ...invalid })).toThrow(
      'Invalid environment variables',
    );
  });

  it('does not expose secret values in validation errors', () => {
    expect(() => validateEnvironment({ DATABASE_URL: 'invalid-private-secret' })).toThrow(
      /^Invalid environment variables: DATABASE_URL$/,
    );
  });
});

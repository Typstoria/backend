import {
  validateEnvironment,
  validateDatabaseEnvironment,
  validateWorkerEnvironment,
} from './environment';

const base = {
  DATABASE_URL: 'postgresql://user:secret@127.0.0.1:5432/typstoria',
  MAIL_FROM: 'sender@example.test',
  MAILJET_API_KEY: 'test-key',
  MAILJET_SECRET_KEY: 'test-secret',
};

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
    expect(
      validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        MAIL_FROM: 'no-reply@example.test',
        MAILJET_API_KEY: 'test-key',
        MAILJET_SECRET_KEY: 'test-secret',
        PUBLIC_WEB_URL: 'https://typstoria.example',
      }).SWAGGER_ENABLED,
    ).toBe(false);
  });

  it('allows Google sign-in to be disabled or configured with a Web client ID', () => {
    expect(validateEnvironment(base).GOOGLE_CLIENT_ID).toBeUndefined();
    expect(
      validateEnvironment({ ...base, GOOGLE_CLIENT_ID: '   ' }).GOOGLE_CLIENT_ID,
    ).toBeUndefined();
    expect(
      validateEnvironment({ ...base, GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com' })
        .GOOGLE_CLIENT_ID,
    ).toBe('test-client.apps.googleusercontent.com');
  });

  it.each([
    { GOOGLE_CLIENT_ID: 'not-a-google-client' },
    { MAIL_FROM: undefined },
    { MAIL_FROM: 'invalid' },
    { MAILJET_API_KEY: undefined },
    { MAILJET_SECRET_KEY: undefined },
    { MAILJET_API_KEY: '   ' },
    { MAILJET_SECRET_KEY: '' },
    { NODE_ENV: 'production' },
    { AUTH_ACCESS_TOKEN_TTL_SECONDS: '0' },
    { PUBLIC_WEB_URL: 'https://example.com/path' },
    { PORT: '0' },
    { PORT: 'invalid' },
    { SWAGGER_ENABLED: 'yes' },
    { DATABASE_URL: 'https://example.com' },
    { DATABASE_POOL_SIZE: '-1' },
    { GIT_STORAGE_PATH: '' },
    { GIT_BINARY_PATH: ' ' },
    { TYPST_BINARY_PATH: ' ' },
    { COMPILE_WORK_PATH: '' },
    { CORS_ORIGINS: '*' },
    { CORS_ORIGINS: 'https://example.com/path' },
    { CORS_ORIGINS: 'https://user:password@example.com' },
  ])('rejects invalid configuration: %j', (invalid) => {
    expect(() => validateEnvironment({ ...base, ...invalid })).toThrow(
      'Invalid environment variables',
    );
  });

  it('validates only database settings for migrations and no mail credentials for workers', () => {
    const database = { DATABASE_URL: base.DATABASE_URL };
    expect(validateDatabaseEnvironment(database).DATABASE_URL).toBe(base.DATABASE_URL);
    expect(validateWorkerEnvironment(database).BLOB_STORAGE_PATH).toBe('.local/blobs');
    expect(() => validateEnvironment(database)).toThrow('Invalid environment variables');
  });

  it('does not expose secret values in validation errors', () => {
    expect(() => validateEnvironment({ ...base, DATABASE_URL: 'invalid-private-secret' })).toThrow(
      /^Invalid environment variables: DATABASE_URL$/,
    );
  });
});

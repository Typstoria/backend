import type { Environment, WorkerEnvironment } from './environment';

export class AppConfigService {
  constructor(readonly environment: Environment | WorkerEnvironment) {}
  private get api(): Environment {
    if (!('MAIL_FROM' in this.environment))
      throw new Error('HTTP configuration is unavailable in a worker');
    return this.environment;
  }
  get production(): boolean {
    return this.environment.NODE_ENV === 'production';
  }
  get gitStoragePath(): string {
    return this.environment.GIT_STORAGE_PATH;
  }
  get gitBinaryPath(): string {
    return this.environment.GIT_BINARY_PATH;
  }
  get typstBinaryPath(): string {
    return this.environment.TYPST_BINARY_PATH;
  }
  get compileWorkPath(): string {
    return this.environment.COMPILE_WORK_PATH;
  }
  get blobStoragePath(): string {
    return this.environment.BLOB_STORAGE_PATH;
  }
  get host(): string {
    return this.api.HOST;
  }
  get port(): number {
    return this.api.PORT;
  }
  get corsOrigins(): string[] {
    return this.api.CORS_ORIGINS;
  }
  get swaggerEnabled(): boolean {
    return this.api.SWAGGER_ENABLED;
  }
  get accessTokenTtlSeconds(): number {
    return this.api.AUTH_ACCESS_TOKEN_TTL_SECONDS;
  }
  get verifyTtlSeconds(): number {
    return this.api.AUTH_VERIFY_TTL_SECONDS;
  }
  get resetTtlSeconds(): number {
    return this.api.AUTH_RESET_TTL_SECONDS;
  }
  get publicWebUrl(): string {
    return this.api.PUBLIC_WEB_URL;
  }
  get googleClientId(): string | undefined {
    return this.api.GOOGLE_CLIENT_ID;
  }
  get mailFrom(): string {
    return this.api.MAIL_FROM;
  }
  get mailjetApiKey(): string {
    return this.api.MAILJET_API_KEY;
  }
  get mailjetSecretKey(): string {
    return this.api.MAILJET_SECRET_KEY;
  }
}

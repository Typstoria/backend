import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from './environment';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  get host(): string {
    return this.config.get('HOST', { infer: true });
  }

  get port(): number {
    return this.config.get('PORT', { infer: true });
  }

  get corsOrigins(): string[] {
    return this.config.get('CORS_ORIGINS', { infer: true });
  }

  get swaggerEnabled(): boolean {
    return this.config.get('SWAGGER_ENABLED', { infer: true });
  }

  get production(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }
  get accessTokenTtlSeconds(): number {
    return this.config.get('AUTH_ACCESS_TOKEN_TTL_SECONDS', { infer: true });
  }
  get verifyTtlSeconds(): number {
    return this.config.get('AUTH_VERIFY_TTL_SECONDS', { infer: true });
  }
  get resetTtlSeconds(): number {
    return this.config.get('AUTH_RESET_TTL_SECONDS', { infer: true });
  }
  get publicWebUrl(): string {
    return this.config.get('PUBLIC_WEB_URL', { infer: true });
  }
  get googleClientId(): string | undefined {
    return this.config.get('GOOGLE_CLIENT_ID', { infer: true });
  }
  get mailFrom(): string {
    return this.config.get('MAIL_FROM', { infer: true });
  }
  get mailjetApiKey(): string {
    return this.config.get('MAILJET_API_KEY', { infer: true });
  }
  get mailjetSecretKey(): string {
    return this.config.get('MAILJET_SECRET_KEY', { infer: true });
  }

  get environment(): Environment {
    return {
      NODE_ENV: this.config.get('NODE_ENV', { infer: true }),
      HOST: this.host,
      PORT: this.port,
      CORS_ORIGINS: this.corsOrigins,
      SWAGGER_ENABLED: this.swaggerEnabled,
      DATABASE_URL: this.config.get('DATABASE_URL', { infer: true }),
      DATABASE_CONNECT_TIMEOUT_MS: this.config.get('DATABASE_CONNECT_TIMEOUT_MS', { infer: true }),
      DATABASE_QUERY_TIMEOUT_MS: this.config.get('DATABASE_QUERY_TIMEOUT_MS', { infer: true }),
      DATABASE_POOL_SIZE: this.config.get('DATABASE_POOL_SIZE', { infer: true }),
      PUBLIC_WEB_URL: this.publicWebUrl,
      GOOGLE_CLIENT_ID: this.googleClientId,
      AUTH_ACCESS_TOKEN_TTL_SECONDS: this.accessTokenTtlSeconds,
      AUTH_VERIFY_TTL_SECONDS: this.verifyTtlSeconds,
      AUTH_RESET_TTL_SECONDS: this.resetTtlSeconds,
      MAIL_FROM: this.config.get('MAIL_FROM', { infer: true }),
      MAILJET_API_KEY: this.config.get('MAILJET_API_KEY', { infer: true }),
      MAILJET_SECRET_KEY: this.config.get('MAILJET_SECRET_KEY', { infer: true }),
    };
  }
}

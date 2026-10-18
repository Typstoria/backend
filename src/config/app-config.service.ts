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
    };
  }
}

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { LiveHealthDto, ReadyHealthDto } from '../http/health-response.dto';

@Injectable()
export class HealthService {
  constructor(private readonly database: DataSource) {}

  live(): LiveHealthDto {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  async ready(): Promise<ReadyHealthDto> {
    try {
      await this.database.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database is unavailable',
      });
    }

    return { ...this.live(), checks: { database: 'up' } };
  }
}

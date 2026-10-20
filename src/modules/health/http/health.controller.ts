import { Controller, Get } from '@nestjs/common';
import { ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { HealthService } from '../application/health.service';
import { LiveHealthDto, ReadyHealthDto } from './health-response.dto';
import { Public } from '../../identity/http/auth-policy';
import { SkipThrottle } from '@nestjs/throttler';

@ApiTags('Health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Check whether the API process is running. */
  @Get('live')
  live(): LiveHealthDto {
    return this.health.live();
  }

  /** Check whether PostgreSQL is reachable. */
  @Get('ready')
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto })
  ready(): Promise<ReadyHealthDto> {
    return this.health.ready();
  }
}

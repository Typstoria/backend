import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { HealthService } from '../application/health.service';
import { LiveHealthDto, ReadyHealthDto } from './health-response.dto';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Check whether the API process is running' })
  @ApiOkResponse({ type: LiveHealthDto })
  live(): LiveHealthDto {
    return this.health.live();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check whether PostgreSQL is reachable' })
  @ApiOkResponse({ type: ReadyHealthDto })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto })
  ready(): Promise<ReadyHealthDto> {
    return this.health.ready();
  }
}

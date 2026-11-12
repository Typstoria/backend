import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IdParam } from '../../common/ids/parse-id.pipe';
import { VerifiedRequired } from '../identity/http/auth-policy';
import type { AuthRequest } from '../identity/http/auth-request';
import { NoStoreInterceptor } from '../identity/http/no-store.interceptor';
import { ListProjectsQueryDto } from '../projects/http/projects.dto';
import { AccessGrantListDto, CreatePatDto, CreatedPatDto } from './access.dto';
import { AccessService } from './access.service';

@ApiTags('MCP access')
@ApiBearerAuth('bearer')
@VerifiedRequired()
@UseInterceptors(NoStoreInterceptor)
@Controller('access')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  /** Create a project-scoped MCP token. Copy the secret from this response; it is shown once. */
  @Post('tokens')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiNotFoundResponse({
    description: 'A selected project does not belong to this account or was deleted.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit or active credential limit.' })
  create(@Req() req: AuthRequest, @Body() input: CreatePatDto): Promise<CreatedPatDto> {
    return this.access.createPat(req.actor!, req.identity!.user.authVersion, input);
  }

  /** List PAT metadata. Secrets are never returned. */
  @Get('tokens')
  tokens(
    @Req() req: AuthRequest,
    @Query() query: ListProjectsQueryDto,
  ): Promise<AccessGrantListDto> {
    return this.access.list(
      req.actor!,
      req.identity!.user.authVersion,
      'pat',
      query.limit,
      query.cursor,
    );
  }

  /** Revoke a PAT. It stops working on the next MCP request. */
  @Delete('tokens/:id')
  @HttpCode(204)
  revokeToken(@Req() req: AuthRequest, @IdParam('id') id: number): Promise<void> {
    return this.access.revoke(req.actor!, 'pat', id);
  }

  /** List authorized OAuth clients and their granted projects and scopes. */
  @Get('connections')
  connections(
    @Req() req: AuthRequest,
    @Query() query: ListProjectsQueryDto,
  ): Promise<AccessGrantListDto> {
    return this.access.list(
      req.actor!,
      req.identity!.user.authVersion,
      'oauth',
      query.limit,
      query.cursor,
    );
  }

  /** Revoke an OAuth connection, including all access and refresh tokens. */
  @Delete('connections/:id')
  @HttpCode(204)
  revokeConnection(@Req() req: AuthRequest, @IdParam('id') id: number): Promise<void> {
    return this.access.revoke(req.actor!, 'oauth', id);
  }
}

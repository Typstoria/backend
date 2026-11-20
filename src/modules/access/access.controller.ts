import { Controller, Delete, Get, HttpCode, Query, Req, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IdParam } from '../../common/ids/parse-id.pipe';
import { VerifiedRequired } from '../identity/http/auth-policy';
import type { AuthRequest } from '../identity/http/auth-request';
import { NoStoreInterceptor } from '../identity/http/no-store.interceptor';
import { ListProjectsQueryDto } from '../projects/http/projects.dto';
import { AccessGrantListDto, OAuthAvailabilityDto } from './access.dto';
import { AccessService } from './access.service';
import { OAuthService } from './oauth.service';

@ApiTags('MCP access')
@ApiBearerAuth('bearer')
@VerifiedRequired()
@UseInterceptors(NoStoreInterceptor)
@Controller('access')
export class AccessController {
  constructor(
    private readonly access: AccessService,
    private readonly oauth: OAuthService,
  ) {}

  /** Return the public MCP address when OAuth is configured. */
  @Get('oauth')
  availability(): OAuthAvailabilityDto {
    const url = this.oauth.resource ?? null;
    return { enabled: url !== null, url };
  }

  /** List authorized OAuth clients and their granted projects and scopes. */
  @Get('connections')
  connections(
    @Req() req: AuthRequest,
    @Query() query: ListProjectsQueryDto,
  ): Promise<AccessGrantListDto> {
    return this.access.list(req.actor!, req.identity!.user.authVersion, query.limit, query.cursor);
  }

  /** Revoke an OAuth connection, including all access and refresh tokens. */
  @Delete('connections/:id')
  @HttpCode(204)
  revokeConnection(@Req() req: AuthRequest, @IdParam('id') id: number): Promise<void> {
    return this.access.revoke(req.actor!, id);
  }
}

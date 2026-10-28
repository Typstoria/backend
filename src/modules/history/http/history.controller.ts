import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { entityIdSchema } from '../../../common/http/entity-id-schema';
import type { ContextRequest } from '../../../common/http/request-context';
import { IdParam } from '../../../common/ids/parse-id.pipe';
import type { AuthRequest } from '../../identity/http/auth-request';
import { VerifiedRequired } from '../../identity/http/auth-policy';
import { NoStoreInterceptor } from '../../identity/http/no-store.interceptor';
import { HistoryService } from '../application/history.service';
import { RevisionDiffService } from '../application/revision-diff.service';
import {
  HistoryRetryDto,
  ListRevisionsQueryDto,
  RestoredRevisionDto,
  RestoreRevisionDto,
  RevisionDetailsDto,
  RevisionDiffDto,
  RevisionDiffQueryDto,
  RevisionListDto,
} from './history.dto';

@ApiTags('Revision history')
@ApiBearerAuth('bearer')
@VerifiedRequired()
@UseInterceptors(NoStoreInterceptor)
@ApiParam({ name: 'projectId', schema: entityIdSchema })
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('projects/:projectId')
export class HistoryController {
  constructor(
    private readonly history: HistoryService,
    private readonly diffs: RevisionDiffService,
  ) {}

  /** List accepted revisions, newest first, with their current Git projection status. */
  @Get('revisions')
  list(
    @IdParam('projectId') projectId: number,
    @Query() query: ListRevisionsQueryDto,
    @Req() request: AuthRequest,
  ): Promise<RevisionListDto> {
    return this.history.list(request.actor!, projectId, query);
  }

  /** Read accepted revision metadata without depending on a running Git worker. */
  @Get('revisions/:revisionId')
  @ApiParam({ name: 'revisionId', schema: entityIdSchema })
  get(
    @IdParam('projectId') projectId: number,
    @IdParam('revisionId') revisionId: number,
    @Req() request: AuthRequest,
  ): Promise<RevisionDetailsDto> {
    return this.history.get(request.actor!, projectId, revisionId);
  }

  /** Compare two immutable snapshots by stable file ID; text patches are bounded. */
  @Get('revisions/:revisionId/diff')
  @ApiParam({ name: 'revisionId', schema: entityIdSchema })
  diff(
    @IdParam('projectId') projectId: number,
    @IdParam('revisionId') revisionId: number,
    @Query() query: RevisionDiffQueryDto,
    @Req() request: AuthRequest,
  ): Promise<RevisionDiffDto> {
    return this.diffs.diff(request.actor!, projectId, revisionId, query.against);
  }

  /** Restore files, entrypoint and context as a new accepted revision with optimistic concurrency. */
  @Post('restore')
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', pattern: '^[A-Za-z0-9._~-]{1,128}$', example: 'restore-revision-1' },
  })
  @ApiBody({
    type: RestoreRevisionDto,
    examples: {
      restore: {
        summary: 'Restore an earlier revision',
        description:
          'Replace targetRevisionId with a historical revision ID and expectedCurrentRevisionId with the current ID from /state.',
        value: {
          targetRevisionId: 1,
          expectedCurrentRevisionId: 2,
          summary: 'Відновлено попередній стан',
        },
      },
    },
  })
  restore(
    @IdParam('projectId') projectId: number,
    @Body() input: RestoreRevisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<RestoredRevisionDto> {
    return this.history.restore(request.actor!, projectId, input, key, request.requestId!);
  }

  /** Retry failed Git projection attempts without changing the document or ready commits. */
  @Post('history/retry')
  @HttpCode(202)
  @ApiAcceptedResponse({ type: HistoryRetryDto })
  retry(
    @IdParam('projectId') projectId: number,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<HistoryRetryDto> {
    return this.history.retry(request.actor!, projectId, request.requestId!);
  }
}

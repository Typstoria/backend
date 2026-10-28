import {
  Controller,
  Get,
  HttpCode,
  Post,
  Body,
  Req,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { entityIdSchema } from '../../../common/http/entity-id-schema';
import type { ContextRequest } from '../../../common/http/request-context';
import { IdParam } from '../../../common/ids/parse-id.pipe';
import { attachmentDisposition } from '../../files/domain/resource-file';
import type { AuthRequest } from '../../identity/http/auth-request';
import { VerifiedRequired } from '../../identity/http/auth-policy';
import { NoStoreInterceptor } from '../../identity/http/no-store.interceptor';
import { CompilationsService } from '../application/compilations.service';
import { CompilationDto, CreateCompilationDto } from './compilation.dto';

@ApiTags('Compilations')
@ApiBearerAuth('bearer')
@VerifiedRequired()
@UseInterceptors(NoStoreInterceptor)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiConflictResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@ApiParam({ name: 'projectId', schema: entityIdSchema })
@Controller('projects/:projectId/compilations')
export class CompilationsController {
  constructor(private readonly compilations: CompilationsService) {}

  /** Queue compilation of one immutable accepted revision; poll the returned job ID. */
  @Post()
  @HttpCode(202)
  @ApiAcceptedResponse({ type: CompilationDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  @ApiBody({
    type: CreateCompilationDto,
    examples: {
      acceptedRevision: { summary: 'Compile a saved revision', value: { revisionId: 1 } },
    },
  })
  create(
    @IdParam('projectId') projectId: number,
    @Body() input: CreateCompilationDto,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<CompilationDto> {
    return this.compilations.create(request.actor!, projectId, input, request.requestId!);
  }

  /** Read status, diagnostics and whether this revision is still current. */
  @Get(':jobId')
  @ApiParam({ name: 'jobId', schema: entityIdSchema })
  get(
    @IdParam('projectId') projectId: number,
    @IdParam('jobId') jobId: number,
    @Req() request: AuthRequest,
  ): Promise<CompilationDto> {
    return this.compilations.get(request.actor!, projectId, jobId);
  }

  /** Download the unexpired PDF of a successful job after checking project ownership. */
  @Get(':jobId/pdf')
  @ApiParam({ name: 'jobId', schema: entityIdSchema })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async pdf(
    @IdParam('projectId') projectId: number,
    @IdParam('jobId') jobId: number,
    @Req() request: AuthRequest,
  ): Promise<StreamableFile> {
    const bytes = await this.compilations.pdf(request.actor!, projectId, jobId);
    return new StreamableFile(bytes, {
      type: 'application/pdf',
      length: bytes.length,
      disposition: attachmentDisposition(`compilation-${jobId}.pdf`),
    });
  }
}

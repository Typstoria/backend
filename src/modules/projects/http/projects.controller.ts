import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiExtraModels,
  ApiPayloadTooLargeResponse,
  ApiUnprocessableEntityResponse,
  ApiNotFoundResponse,
  ApiNoContentResponse,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { IdParam } from '../../../common/ids/parse-id.pipe';
import type { ContextRequest } from '../../../common/http/request-context';
import { entityIdSchema as idSchema } from '../../../common/http/entity-id-schema';
import type { AuthRequest } from '../../identity/http/auth-request';
import { VerifiedRequired } from '../../identity/http/auth-policy';
import { NoStoreInterceptor } from '../../identity/http/no-store.interceptor';
import { ProjectsService } from '../application/projects.service';
import { ProjectChangesService } from '../application/project-changes.service';
import { projectChangesExamples } from './project-changes.examples';
import {
  changeOperationModels,
  ProjectChangesDto,
  ProjectChangesResultDto,
} from './project-changes.dto';
import {
  CreateProjectDto,
  FileRevisionQueryDto,
  ListProjectsQueryDto,
  ProjectCreatedDto,
  ProjectDto,
  ProjectListDto,
  ProjectStateDto,
  ProjectTextFileDto,
  RenameProjectDto,
} from './projects.dto';

@ApiTags('Projects')
@ApiBearerAuth('bearer')
@VerifiedRequired()
@UseInterceptors(NoStoreInterceptor)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly changes: ProjectChangesService,
  ) {}

  /** Atomically save text, uploaded resources, paths, entrypoint and context as one accepted revision. */
  @Post(':projectId/changes')
  @ApiParam({ name: 'projectId', schema: idSchema })
  @ApiExtraModels(...changeOperationModels)
  @ApiBody({ type: ProjectChangesDto, examples: projectChangesExamples })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' },
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description:
      'REVISION_CONFLICT or IDEMPOTENCY_CONFLICT. Keep the local draft and reload state.',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorResponseDto,
    description: 'Invalid paths, file references or final entrypoint/tree.',
  })
  @ApiPayloadTooLargeResponse({ type: ErrorResponseDto })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto })
  save(
    @IdParam('projectId') projectId: number,
    @Body() dto: ProjectChangesDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProjectChangesResultDto> {
    return this.changes.save(request.actor!, projectId, dto, key, request.requestId!);
  }

  /** Create a private project with an empty main.typ and accepted revision 1. */
  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' },
    description:
      'Scoped to the current web session. Reuse with the same title returns the original result.',
  })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'IDEMPOTENCY_CONFLICT: this key was used with another title.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'The project from an earlier request has been deleted.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description: 'STORAGE_UNAVAILABLE: no project was created.',
  })
  create(
    @Body() dto: CreateProjectDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProjectCreatedDto> {
    return this.projects.create(request.actor!, dto.title, key, request.requestId!);
  }

  /** List active projects owned by the current user, newest IDs first. */
  @Get()
  list(@Query() query: ListProjectsQueryDto, @Req() request: AuthRequest): Promise<ProjectListDto> {
    return this.projects.list(request.actor!, query.limit, query.cursor);
  }

  /** Rename an owned project. The last completed rename wins. */
  @Patch(':projectId')
  @ApiParam({ name: 'projectId', schema: idSchema })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  rename(
    @IdParam('projectId') projectId: number,
    @Body() dto: RenameProjectDto,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProjectDto> {
    return this.projects.rename(request.actor!, projectId, dto.title, request.requestId!);
  }

  /** Soft-delete an owned project and immediately block subsequent access. */
  @Delete(':projectId')
  @HttpCode(204)
  @ApiParam({ name: 'projectId', schema: idSchema })
  @ApiNoContentResponse({ description: 'Project marked as deleted. Physical cleanup is deferred.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async delete(
    @IdParam('projectId') projectId: number,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<void> {
    await this.projects.delete(request.actor!, projectId, request.requestId!);
  }

  /** Read metadata of an owned project. */
  @Get(':projectId')
  @ApiParam({ name: 'projectId', schema: idSchema })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@IdParam('projectId') projectId: number, @Req() request: AuthRequest): Promise<ProjectDto> {
    return this.projects.get(request.actor!, projectId);
  }

  /** Read the current accepted revision, file tree, entrypoint and context. */
  @Get(':projectId/state')
  @ApiParam({ name: 'projectId', schema: idSchema })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  state(
    @IdParam('projectId') projectId: number,
    @Query() query: FileRevisionQueryDto,
    @Req() request: AuthRequest,
  ): Promise<ProjectStateDto> {
    return this.projects.state(request.actor!, projectId, query.revisionId);
  }

  /** Read a text file from an owned project's accepted revision. */
  @Get(':projectId/files/:fileId')
  @ApiParam({ name: 'projectId', schema: idSchema })
  @ApiParam({ name: 'fileId', schema: idSchema })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto })
  readFile(
    @IdParam('projectId') projectId: number,
    @IdParam('fileId') fileId: number,
    @Query() query: FileRevisionQueryDto,
    @Req() request: AuthRequest,
  ): Promise<ProjectTextFileDto> {
    return this.projects.readTextFile(request.actor!, projectId, fileId, query.revisionId);
  }
}

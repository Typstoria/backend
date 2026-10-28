import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  StreamableFile,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { entityIdSchema } from '../../../common/http/entity-id-schema';
import type { ContextRequest } from '../../../common/http/request-context';
import { IdParam } from '../../../common/ids/parse-id.pipe';
import type { AuthRequest } from '../../identity/http/auth-request';
import { VerifiedRequired } from '../../identity/http/auth-policy';
import { NoStoreInterceptor } from '../../identity/http/no-store.interceptor';
import {
  attachmentDisposition,
  MAX_RESOURCE_BYTES,
  UploadedResource,
} from '../../files/domain/resource-file';
import { ProjectUploadsService } from '../application/project-uploads.service';
import { ProjectsService } from '../application/projects.service';
import { ProjectUploadDto } from './project-uploads.dto';
import { FileRevisionQueryDto } from './projects.dto';

@ApiTags('Project resources')
@ApiBearerAuth('bearer')
@VerifiedRequired()
@UseInterceptors(NoStoreInterceptor)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('projects/:projectId')
@ApiParam({ name: 'projectId', schema: entityIdSchema })
export class ProjectResourcesController {
  constructor(
    private readonly uploads: ProjectUploadsService,
    private readonly projects: ProjectsService,
  ) {}

  /** Stage one resource for 24 hours without changing the current document revision. */
  @Post('uploads')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'PNG/JPEG/GIF/WebP/PDF/TTF/OTF/WOFF/WOFF2; up to 10 MiB.',
        },
      },
    },
  })
  @ApiPayloadTooLargeResponse({ type: ErrorResponseDto })
  @ApiUnsupportedMediaTypeResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  @UseInterceptors(
    FileInterceptor('file', {
      preservePath: true,
      defParamCharset: 'utf8',
      limits: {
        fileSize: MAX_RESOURCE_BYTES,
        files: 1,
        fields: 0,
        parts: 2,
        headerPairs: 32,
      },
    }),
  )
  upload(
    @IdParam('projectId') projectId: number,
    @UploadedFile() file: UploadedResource | undefined,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProjectUploadDto> {
    if (!request.is('multipart/form-data'))
      throw new UnsupportedMediaTypeException('Use multipart/form-data with one file field');
    return this.uploads.upload(request.actor!, projectId, file, request.requestId!);
  }

  /** Read the status of a project-bound staged or attached upload. */
  @Get('uploads/:uploadId')
  @ApiParam({ name: 'uploadId', schema: entityIdSchema })
  get(
    @IdParam('projectId') projectId: number,
    @IdParam('uploadId') uploadId: number,
    @Req() request: AuthRequest,
  ): Promise<ProjectUploadDto> {
    return this.uploads.get(request.actor!, projectId, uploadId);
  }

  /** Download a file from the current or selected accepted revision as an attachment. */
  @Get('files/:fileId/download')
  @ApiParam({ name: 'fileId', schema: entityIdSchema })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async download(
    @IdParam('projectId') projectId: number,
    @IdParam('fileId') fileId: number,
    @Query() query: FileRevisionQueryDto,
    @Req() request: AuthRequest,
  ): Promise<StreamableFile> {
    const file = await this.projects.downloadFile(
      request.actor!,
      projectId,
      fileId,
      query.revisionId,
    );
    return new StreamableFile(file.content, {
      type: file.mediaType,
      length: file.content.length,
      disposition: attachmentDisposition(file.filename),
    });
  }
}

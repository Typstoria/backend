import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  Query,
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
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { entityIdSchema } from '../../../common/http/entity-id-schema';
import type { ContextRequest } from '../../../common/http/request-context';
import { IdParam } from '../../../common/ids/parse-id.pipe';
import { attachmentDisposition } from '../../files/domain/resource-file';
import { VerifiedRequired } from '../../identity/http/auth-policy';
import type { AuthRequest } from '../../identity/http/auth-request';
import { NoStoreInterceptor } from '../../identity/http/no-store.interceptor';
import { changeOperationModels } from '../../projects/http/project-changes.dto';
import { projectChangesExamples } from '../../projects/http/project-changes.examples';
import { ListProjectsQueryDto } from '../../projects/http/projects.dto';
import { ProposalsService } from '../application/proposals.service';
import {
  AcceptProposalDto,
  CandidateQueryDto,
  CreateProposalDto,
  ProposalAcceptedDto,
  ProposalCandidateDto,
  ProposalDiffDto,
  ProposalDto,
  ProposalListDto,
  ProposalTextFileDto,
  ProposalValidationDto,
  ProposalVersionDto,
  RebaseProposalDto,
  UpdateProposalDto,
} from './proposals.dto';

@ApiTags('Proposals')
@ApiBearerAuth('bearer')
@VerifiedRequired()
@UseInterceptors(NoStoreInterceptor)
@ApiParam({ name: 'projectId', schema: entityIdSchema })
@ApiExtraModels(...changeOperationModels)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiConflictResponse({ type: ErrorResponseDto })
@ApiPayloadTooLargeResponse({ type: ErrorResponseDto })
@ApiUnprocessableEntityResponse({ type: ErrorResponseDto })
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('projects/:projectId/proposals')
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Post()
  @ApiOperation({
    summary: 'Створити пропозицію змін без зміни основного документа',
    description:
      'Візьміть baseRevisionId та fileId з /state. Operations мають той самий формат, що /changes. Зберігається окремий незмінний candidate; пропозиція діє 7 днів. Далі перегляньте /candidate і /diff, виконайте /validate та /accept або /reject. До 50 активних пропозицій на проєкт.',
  })
  @ApiBody({ type: CreateProposalDto, examples: projectChangesExamples })
  create(
    @IdParam('projectId') projectId: number,
    @Body() input: CreateProposalDto,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProposalDto> {
    return this.proposals.create(request.actor!, projectId, input, request.requestId!);
  }

  @Get()
  @ApiOperation({
    summary: 'Список пропозицій проєкту',
    description:
      'Новіші ID першими; nextCursor передається як cursor наступної сторінки. isStale означає, що основний документ уже змінився відносно бази пропозиції.',
  })
  list(
    @IdParam('projectId') projectId: number,
    @Query() query: ListProjectsQueryDto,
    @Req() request: AuthRequest,
  ): Promise<ProposalListDto> {
    return this.proposals.list(request.actor!, projectId, query);
  }

  @Get(':proposalId')
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiOperation({
    summary: 'Стан і поточна версія пропозиції',
    description:
      'version потрібна як expectedProposalVersion. candidateManifestHash фіксує точний стан для прийняття. latestValidationId стосується лише поточної candidate version; acceptedRevisionId заповнюється після прийняття.',
  })
  get(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @Req() request: AuthRequest,
  ): Promise<ProposalDto> {
    return this.proposals.get(request.actor!, projectId, id);
  }

  @Patch(':proposalId')
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiOperation({
    summary: 'Замінити набір змін і створити нову candidate version',
    description:
      'Передайте expectedProposalVersion, operations і необов’язковий summary. Весь operations застосовується заново до початкової baseRevisionId, а не до попереднього candidate. Стара validation не підходить новій версії. Максимум 100 версій.',
  })
  update(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @Body() input: UpdateProposalDto,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProposalDto> {
    return this.proposals.update(request.actor!, projectId, id, input, request.requestId!);
  }

  @Post(':proposalId/rebase')
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiOperation({
    summary: 'Перебудувати пропозицію на актуальній ревізії',
    description:
      'Прочитайте свіжий /state, узгодьте зміни й передайте нову baseRevisionId, expectedProposalVersion та повний operations. Автоматичного merge немає. Створюється нова candidate version, яку потрібно перевірити заново.',
  })
  rebase(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @Body() input: RebaseProposalDto,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProposalDto> {
    return this.proposals.rebase(request.actor!, projectId, id, input, request.requestId!);
  }

  @Get(':proposalId/candidate')
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiOperation({
    summary: 'Дерево файлів, entrypoint і контекст пропозиції',
    description:
      'Без candidateVersion читається остання версія. ID candidateSnapshotId не можна передавати замість revisionId в accepted-document endpoints.',
  })
  state(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @Query() query: CandidateQueryDto,
    @Req() request: AuthRequest,
  ): Promise<ProposalCandidateDto> {
    return this.proposals.state(request.actor!, projectId, id, query.candidateVersion);
  }

  @Get(':proposalId/files/:fileId')
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiParam({ name: 'fileId', schema: entityIdSchema })
  @ApiOperation({ summary: 'Текст файла із candidate, включно з новими файлами' })
  file(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @IdParam('fileId') fileId: number,
    @Query() query: CandidateQueryDto,
    @Req() request: AuthRequest,
  ): Promise<ProposalTextFileDto> {
    return this.proposals.textFile(request.actor!, projectId, id, fileId, query.candidateVersion);
  }

  @Get(':proposalId/files/:fileId/download')
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiParam({ name: 'fileId', schema: entityIdSchema })
  @ApiOperation({ summary: 'Скачати текстовий або бінарний файл із candidate' })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async download(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @IdParam('fileId') fileId: number,
    @Query() query: CandidateQueryDto,
    @Req() request: AuthRequest,
  ): Promise<StreamableFile> {
    const file = await this.proposals.file(
      request.actor!,
      projectId,
      id,
      fileId,
      query.candidateVersion,
    );
    return new StreamableFile(file.content, {
      type: file.metadata.mediaType,
      length: file.content.length,
      disposition: attachmentDisposition(file.metadata.path.split('/').at(-1)!),
    });
  }

  @Get(':proposalId/diff')
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiOperation({
    summary: 'Diff від базової ревізії до candidate',
    description:
      'files містить зміни всіх файлів, context — окремого контексту, entrypoint — головного файла. Ліміти текстових patches такі самі, як у revision diff.',
  })
  diff(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @Query() query: CandidateQueryDto,
    @Req() request: AuthRequest,
  ): Promise<ProposalDiffDto> {
    return this.proposals.diff(request.actor!, projectId, id, query.candidateVersion);
  }

  @Post(':proposalId/validate')
  @HttpCode(202)
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiAcceptedResponse({ type: ProposalValidationDto })
  @ApiOperation({
    summary: 'Перевірити точну версію пропозиції та створити preview PDF',
    description:
      'Передайте expectedProposalVersion. Для зміни файлів/entrypoint повертається compileJobId: опитуйте /validations/{validationId}, а PDF завантажуйте через /compilations/{compileJobId}/pdf. Для context-only/no-op результат not_required і job не створюється. Основний документ не змінюється.',
  })
  validate(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @Body() input: ProposalVersionDto,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProposalValidationDto> {
    return this.proposals.validate(
      request.actor!,
      projectId,
      id,
      input.expectedProposalVersion,
      request.requestId!,
    );
  }

  @Get(':proposalId/validations/:validationId')
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiParam({ name: 'validationId', schema: entityIdSchema })
  @ApiOperation({
    summary: 'Результат перевірки: pending робота, PDF або Typst diagnostics',
    description:
      'queued/running — зачекайте; succeeded/not_required — можна приймати; compile_failed — Typst error, потрібне явне підтвердження; validation_failed — infrastructure/timeout/limits, прийняття заборонене.',
  })
  validation(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @IdParam('validationId') validationId: number,
    @Req() request: AuthRequest,
  ): Promise<ProposalValidationDto> {
    return this.proposals.validation(request.actor!, projectId, id, validationId);
  }

  @Post(':proposalId/accept')
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', pattern: '^[A-Za-z0-9._~-]{1,128}$', example: 'accept-proposal-1' },
  })
  @ApiOperation({
    summary: 'Прийняти перевірену пропозицію як нову ревізію',
    description:
      'Лише вебсесія власника. Передайте baseRevisionId, expectedProposalVersion, validationId та candidateManifestHash саме переглянутого стану. Якщо база змінилася — 409 REVISION_CONFLICT. acknowledgeCompileFailure=true дозволяє лише явно прийняти фактичний TYPST_ERROR; інші збої та неперевірені зміни не пропускає. No-op не створює зайвої ревізії. Повтор ключа з тим самим payload повертає той самий результат.',
  })
  accept(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @Body() input: AcceptProposalDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProposalAcceptedDto> {
    return this.proposals.accept(request.actor!, projectId, id, input, key, request.requestId!);
  }

  @Post(':proposalId/reject')
  @HttpCode(200)
  @ApiParam({ name: 'proposalId', schema: entityIdSchema })
  @ApiOperation({
    summary: 'Відхилити поточну версію пропозиції',
    description:
      'Лише вебсесія власника. Передайте expectedProposalVersion. Основний документ та його історія залишаються без змін; закриту пропозицію більше не можна редагувати чи прийняти.',
  })
  reject(
    @IdParam('projectId') projectId: number,
    @IdParam('proposalId') id: number,
    @Body() input: ProposalVersionDto,
    @Req() request: AuthRequest & ContextRequest,
  ): Promise<ProposalDto> {
    return this.proposals.reject(
      request.actor!,
      projectId,
      id,
      input.expectedProposalVersion,
      request.requestId!,
    );
  }
}

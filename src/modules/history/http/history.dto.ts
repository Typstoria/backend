import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { entityIdSchema } from '../../../common/http/entity-id-schema';
import { parseEntityId } from '../../../common/ids/numeric-id';
import {
  ListProjectsQueryDto,
  ProjectCreatedDto,
  ProjectFileDto,
  ProjectRevisionDto,
} from '../../projects/http/projects.dto';
import type { HistoryErrorCode, HistorySyncStatus } from '../domain/git-history';

export class ListRevisionsQueryDto extends ListProjectsQueryDto {
  /** Last revision number from the previous page; newer revisions appear first. */
  @ApiProperty({
    ...entityIdSchema,
    required: false,
    description: 'Revision number cursor, exclusive; ordered by number descending.',
  })
  cursor?: number;
}

export class RevisionDiffQueryDto {
  /** Compare this source revision against the revision in the route. */
  @ApiProperty(entityIdSchema)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (parseEntityId(value) ?? value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  against!: number;
}

export class RevisionDetailsDto extends ProjectRevisionDto {
  @ApiProperty(entityIdSchema) projectId!: number;
  @ApiProperty(entityIdSchema) actorId!: number;
  channel!: 'web' | 'mcp';
  operation!: string;
  summary!: string;
  isCurrent!: boolean;
  @ApiProperty({ type: String, nullable: true }) historyErrorCode!: HistoryErrorCode | null;
}

export class RevisionListDto {
  items!: RevisionDetailsDto[];
  @ApiProperty({ ...entityIdSchema, nullable: true }) nextCursor!: number | null;
}

export type PatchOmittedReason =
  'BINARY' | 'TEXT_TOO_LARGE' | 'PATCH_LIMIT' | 'COMPUTATION_LIMIT' | null;

export class FileDiffDto {
  @ApiProperty(entityIdSchema) fileId!: number;
  @ApiProperty({ type: [String], example: ['renamed', 'modified'] }) changes!: (
    'added' | 'deleted' | 'renamed' | 'modified'
  )[];
  @ApiProperty({ type: ProjectFileDto, nullable: true }) before!: ProjectFileDto | null;
  @ApiProperty({ type: ProjectFileDto, nullable: true }) after!: ProjectFileDto | null;
  @ApiProperty({ type: String, nullable: true }) patch!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['BINARY', 'TEXT_TOO_LARGE', 'PATCH_LIMIT', 'COMPUTATION_LIMIT'],
  })
  patchOmittedReason!: PatchOmittedReason;
}

export class ContextDiffDto {
  changed!: boolean;
  @ApiProperty({ type: String, nullable: true }) patch!: string | null;
  @ApiProperty({ type: String, nullable: true }) patchOmittedReason!: PatchOmittedReason;
}

export class EntrypointDiffDto {
  changed!: boolean;
  @ApiProperty(entityIdSchema) beforeFileId!: number;
  @ApiProperty(entityIdSchema) afterFileId!: number;
}

export class RevisionDiffDto {
  @ApiProperty(entityIdSchema) fromRevisionId!: number;
  @ApiProperty(entityIdSchema) toRevisionId!: number;
  @ApiProperty({ enum: ['pending', 'ready', 'failed'] }) fromHistorySyncStatus!: HistorySyncStatus;
  @ApiProperty({ enum: ['pending', 'ready', 'failed'] }) toHistorySyncStatus!: HistorySyncStatus;
  files!: FileDiffDto[];
  context!: ContextDiffDto;
  entrypoint!: EntrypointDiffDto;
}

export class RestoreRevisionDto {
  @ApiProperty(entityIdSchema) @IsInt() @Min(1) @Max(2147483647) targetRevisionId!: number;
  @ApiProperty(entityIdSchema) @IsInt() @Min(1) @Max(2147483647) expectedCurrentRevisionId!: number;
  @ApiPropertyOptional({ example: 'Відновлено попередній стан документа' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 500)
  @Matches(/^\P{Cc}+$/u)
  summary?: string;
}

export class RestoredRevisionDto extends ProjectCreatedDto {
  @ApiProperty(entityIdSchema) restoredFromRevisionId!: number;
}

export class HistoryRetryDto {
  @ApiProperty(entityIdSchema) projectId!: number;
  resetCount!: number;
}

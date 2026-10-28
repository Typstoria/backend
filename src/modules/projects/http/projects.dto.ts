import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { parseEntityId } from '../../../common/ids/numeric-id';
import { entityIdSchema as entityId } from '../../../common/http/entity-id-schema';

export class CreateProjectDto {
  /** Project title; surrounding whitespace is removed. @example Дипломна робота */
  @ApiProperty({ example: 'Дипломна робота' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 200)
  @Matches(/^\P{Cc}+$/u, { message: 'title must not contain control characters' })
  title!: string;
}

export class RenameProjectDto extends CreateProjectDto {}

export class ListProjectsQueryDto {
  /** Last project ID from the previous page; projects are ordered by ID descending. */
  @ApiProperty({ ...entityId, required: false })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (parseEntityId(value) ?? value) : value,
  )
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  cursor?: number;

  /** Number of projects per page. */
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 100, default: 20, required: false })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (parseEntityId(value) ?? value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class FileRevisionQueryDto {
  /** Omit to read the current accepted revision. */
  @ApiProperty({ ...entityId, required: false })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (parseEntityId(value) ?? value) : value,
  )
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revisionId?: number;
}

export class ProjectCreatedDto {
  @ApiProperty(entityId)
  projectId!: number;

  @ApiProperty(entityId)
  revisionId!: number;

  revisionNumber!: number;

  @ApiProperty(entityId)
  mainFileId!: number;

  manifestHash!: string;

  /** Git processing is asynchronous; query revision history for its current status. */
  historySyncStatus!: 'pending' | 'ready' | 'failed';
}

export class ProjectDto {
  @ApiProperty(entityId)
  id!: number;

  title!: string;

  @ApiProperty(entityId)
  currentRevisionId!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class ProjectListDto {
  items!: ProjectDto[];

  /** Pass as cursor to fetch the next page; null means there are no more results. */
  @ApiProperty({ ...entityId, nullable: true })
  nextCursor!: number | null;
}

export class ProjectRevisionDto {
  @ApiProperty({ enum: ['pending', 'ready', 'failed'] })
  historySyncStatus!: 'pending' | 'ready' | 'failed' | 'ready' | 'failed';

  @ApiProperty({ type: String, nullable: true })
  commitSha!: string | null;

  @ApiProperty(entityId)
  id!: number;

  number!: number;

  @ApiProperty({ ...entityId, nullable: true })
  parentRevisionId!: number | null;

  manifestHash!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class ProjectFileDto {
  @ApiProperty(entityId)
  fileId!: number;

  path!: string;
  contentKind!: 'text' | 'binary';
  sha256!: string;
  sizeBytes!: number;
  mediaType!: string;
}

export class ProjectStateDto {
  project!: ProjectDto;
  revision!: ProjectRevisionDto;

  @ApiProperty(entityId)
  mainFileId!: number;

  contextText!: string;
  tree!: ProjectFileDto[];
}

export class ProjectTextFileDto extends ProjectFileDto {
  @ApiProperty(entityId)
  revisionId!: number;

  /** UTF-8 source content. The initial main.typ is empty. */
  content!: string;
}

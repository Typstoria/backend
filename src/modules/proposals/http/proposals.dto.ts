import { ApiProperty, ApiPropertyOptional, OmitType, PickType } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { entityIdSchema } from '../../../common/http/entity-id-schema';
import { parseEntityId } from '../../../common/ids/numeric-id';
import { ProjectChangesDto } from '../../projects/http/project-changes.dto';
import { ProjectCreatedDto, ProjectFileDto } from '../../projects/http/projects.dto';
import { RevisionDiffDto } from '../../history/http/history.dto';
import { CompileDiagnosticDto } from '../../compilation/http/compilation.dto';

export class CreateProposalDto extends ProjectChangesDto {}

export class ProposalVersionDto {
  /** Version returned by GET proposal; protects against overwriting a newer candidate. */
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 100, example: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  expectedProposalVersion!: number;
}

/** Replaces the entire operation list, applied to the same accepted base revision. */
export class UpdateProposalDto extends OmitType(ProjectChangesDto, ['baseRevisionId'] as const) {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 100, example: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  expectedProposalVersion!: number;
}

/** Explicitly rebuild on the current accepted revision; no automatic text merge. */
export class RebaseProposalDto extends ProjectChangesDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 100, example: 1 })
  @IsInt()
  @Min(1)
  @Max(100)
  expectedProposalVersion!: number;
}

export class AcceptProposalDto extends ProposalVersionDto {
  @ApiProperty(entityIdSchema) @IsInt() @Min(1) @Max(2147483647) baseRevisionId!: number;
  @ApiProperty(entityIdSchema) @IsInt() @Min(1) @Max(2147483647) validationId!: number;
  /** Copy from the candidate being reviewed; accepting a different hash is forbidden. */
  @ApiProperty({ example: 'a'.repeat(64), pattern: '^[a-f0-9]{64}$' })
  @Matches(/^[a-f0-9]{64}$/)
  candidateManifestHash!: string;
  /** Only acknowledges an actual Typst error; never bypasses missing validation or infrastructure failure. */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  acknowledgeCompileFailure?: boolean;
}

export class CandidateQueryDto {
  /** Omit to read the latest candidate; older immutable versions remain readable. */
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (parseEntityId(value) ?? value) : value,
  )
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  candidateVersion?: number;
}

export class ProposalDto {
  @ApiProperty(entityIdSchema) id!: number;
  @ApiProperty(entityIdSchema) projectId!: number;
  @ApiProperty(entityIdSchema) creatorId!: number;
  channel!: 'web' | 'mcp';
  @ApiProperty({ enum: ['draft', 'accepted', 'rejected', 'expired'] }) status!:
    'draft' | 'accepted' | 'rejected' | 'expired';
  version!: number;
  @ApiProperty(entityIdSchema) baseRevisionId!: number;
  @ApiProperty(entityIdSchema) candidateSnapshotId!: number;
  candidateManifestHash!: string;
  summary!: string;
  /** The main document no longer matches this candidate's base. Rebase before acceptance. */
  isStale!: boolean;
  @ApiProperty({ ...entityIdSchema, nullable: true }) acceptedRevisionId!: number | null;
  @ApiProperty({ ...entityIdSchema, nullable: true }) latestValidationId!: number | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class ProposalListDto {
  items!: ProposalDto[];
  @ApiProperty({ ...entityIdSchema, nullable: true }) nextCursor!: number | null;
}

export class ProposalCandidateDto extends PickType(ProjectChangesDto, ['operations'] as const) {
  @ApiProperty(entityIdSchema) proposalId!: number;
  candidateVersion!: number;
  @ApiProperty(entityIdSchema) baseRevisionId!: number;
  @ApiProperty(entityIdSchema) candidateSnapshotId!: number;
  candidateManifestHash!: string;
  @ApiProperty(entityIdSchema) mainFileId!: number;
  contextText!: string;
  tree!: ProjectFileDto[];
  directories!: string[];
}

export class ProposalTextFileDto extends ProjectFileDto {
  candidateVersion!: number;
  content!: string;
}

export class ProposalDiffDto extends PickType(RevisionDiffDto, [
  'files',
  'directories',
  'context',
  'entrypoint',
] as const) {
  @ApiProperty(entityIdSchema) baseRevisionId!: number;
  @ApiProperty(entityIdSchema) proposalId!: number;
  candidateVersion!: number;
  candidateManifestHash!: string;
}

export type ValidationStatus =
  'not_required' | 'queued' | 'running' | 'succeeded' | 'compile_failed' | 'validation_failed';
export class ProposalValidationDto {
  @ApiProperty(entityIdSchema) id!: number;
  @ApiProperty(entityIdSchema) proposalId!: number;
  candidateVersion!: number;
  candidateManifestHash!: string;
  @ApiProperty({
    enum: ['not_required', 'queued', 'running', 'succeeded', 'compile_failed', 'validation_failed'],
  })
  status!: ValidationStatus;
  @ApiProperty({ ...entityIdSchema, nullable: true }) compileJobId!: number | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  diagnostics!: CompileDiagnosticDto[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ProposalAcceptedDto extends ProjectCreatedDto {
  @ApiProperty(entityIdSchema) proposalId!: number;
}

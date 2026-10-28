import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { entityIdSchema } from '../../../common/http/entity-id-schema';
import type { CompileErrorCode, CompileStatus } from '../domain/compilation';

export class CreateCompilationDto {
  @ApiProperty(entityIdSchema)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revisionId!: number;
}

export class CompileDiagnosticDto {
  @ApiProperty({ ...entityIdSchema, nullable: true }) fileId!: number | null;
  @ApiProperty({ type: String, nullable: true, example: 'main.typ' }) path!: string | null;
  severity!: 'error' | 'warning';
  @ApiProperty({ example: 'unclosed delimiter' }) message!: string;
  /** Exact UTF-16 ranges are not available in this CLI adapter yet. */
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: false }) range!: null;
}

export class CompilationDto {
  @ApiProperty(entityIdSchema) id!: number;
  @ApiProperty(entityIdSchema) projectId!: number;
  @ApiProperty(entityIdSchema) revisionId!: number;
  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled'] })
  status!: CompileStatus;
  @ApiProperty({ type: String, nullable: true }) errorCode!: CompileErrorCode | null;
  @ApiProperty({ example: 'a'.repeat(64) }) inputManifestHash!: string;
  @ApiProperty({ type: String, nullable: true, example: 'b'.repeat(64) }) compilerFingerprint!:
    string | null;
  isCurrent!: boolean;
  artifactAvailable!: boolean;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) artifactExpiresAt!:
    string | null;
  diagnostics!: CompileDiagnosticDto[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) startedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) finishedAt!: string | null;
}

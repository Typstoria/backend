import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { mcpScopes, type McpScope } from '../../common/actor/access-policy';
import { entityIdSchema } from '../../common/http/entity-id-schema';

export class CreatePatDto {
  @ApiProperty({ example: 'Local MCP client' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 100)
  @Matches(/^\P{Cc}+$/u)
  name!: string;

  /** Only these active projects will be accessible to this token. */
  @ApiProperty({ type: 'array', items: entityIdSchema, minItems: 1, maxItems: 50, example: [1] })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  projectIds!: number[];

  @ApiProperty({ enum: mcpScopes, isArray: true, example: ['projects:read', 'documents:read'] })
  @ArrayMinSize(1)
  @ArrayMaxSize(mcpScopes.length)
  @ArrayUnique()
  @IsIn(mcpScopes, { each: true })
  scopes!: McpScope[];

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 90, default: 30 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(90)
  expiresInDays?: number;
}

export class AccessGrantDto {
  @ApiProperty(entityIdSchema) id!: number;
  name!: string;
  @ApiProperty({ enum: mcpScopes, isArray: true }) scopes!: McpScope[];
  @ApiProperty({ type: 'array', items: entityIdSchema }) projectIds!: number[];
  @ApiProperty({ type: String, nullable: true }) clientId!: string | null;
  @ApiProperty({ enum: ['active', 'expired', 'revoked'] }) status!:
    'active' | 'expired' | 'revoked';
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) revokedAt!: string | null;
}

export class AccessGrantListDto {
  items!: AccessGrantDto[];
  @ApiProperty({ ...entityIdSchema, nullable: true }) nextCursor!: number | null;
}

export class CreatedPatDto extends AccessGrantDto {
  /** Copy now; this secret cannot be retrieved again. Use it only with /mcp. */
  token!: string;
}

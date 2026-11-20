import { ApiProperty } from '@nestjs/swagger';
import { mcpScopes, type McpScope } from '../../common/actor/access-policy';
import { entityIdSchema } from '../../common/http/entity-id-schema';

export class ConnectionProjectDto {
  @ApiProperty(entityIdSchema) id!: number;
  title!: string;
}

export class AccessGrantDto {
  @ApiProperty(entityIdSchema) id!: number;
  name!: string;
  @ApiProperty({ enum: mcpScopes, isArray: true }) scopes!: McpScope[];
  @ApiProperty({ type: 'array', items: entityIdSchema }) projectIds!: number[];
  projects!: ConnectionProjectDto[];
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

export class OAuthAvailabilityDto {
  enabled!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uri' }) url!: string | null;
}

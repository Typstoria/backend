import { ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorBodyDto {
  /** @example RESOURCE_NOT_FOUND */
  code!: string;

  /** @example "Resource not found" */
  message!: string;

  /** @example f095b371-20ea-4e2f-99f3-e4c724161491 */
  requestId!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  details?: Record<string, unknown>;
}

export class ErrorResponseDto {
  error!: ErrorBodyDto;
}

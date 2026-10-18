import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorBodyDto {
  @ApiProperty({ example: 'RESOURCE_NOT_FOUND' })
  code!: string;

  @ApiProperty({ example: 'Resource not found' })
  message!: string;

  @ApiProperty({ example: 'f095b371-20ea-4e2f-99f3-e4c724161491' })
  requestId!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  details?: Record<string, unknown>;
}

export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto })
  error!: ErrorBodyDto;
}

import { ApiProperty } from '@nestjs/swagger';
import { entityIdSchema } from '../../../common/http/entity-id-schema';

export class ProjectUploadDto {
  @ApiProperty(entityIdSchema)
  uploadId!: number;

  @ApiProperty({ example: 'logo.png' })
  filename!: string;
  @ApiProperty({ example: 'image/png' })
  mediaType!: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 10485760, example: 68 })
  sizeBytes!: number;
  @ApiProperty({ example: 'a'.repeat(64) })
  sha256!: string;
  status!: 'available' | 'expired';

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

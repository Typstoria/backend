import { Type, Transform } from 'class-transformer';
import { BadRequestException } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { MAX_CHANGE_OPERATIONS } from '../domain/text-changes';
import { ProjectCreatedDto } from './projects.dto';
import { entityIdSchema as entityId } from '../../../common/http/entity-id-schema';

export class ChangeOperationDto {
  @IsIn([
    'createFile',
    'updateText',
    'renameFile',
    'deleteFile',
    'setEntrypoint',
    'updateContext',
    'attachFile',
    'replaceFile',
  ])
  type!: string;
}

export class CreateTextFileDto extends ChangeOperationDto {
  @Equals('createFile')
  type!: 'createFile';

  @IsString()
  @Length(1, 1024)
  path!: string;

  @IsString()
  content!: string;
}

export class UpdateTextDto extends ChangeOperationDto {
  @Equals('updateText')
  type!: 'updateText';

  @ApiProperty(entityId)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  fileId!: number;

  @IsString()
  content!: string;
}

export class RenameFileDto extends ChangeOperationDto {
  @Equals('renameFile')
  type!: 'renameFile';

  @ApiProperty(entityId)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  fileId!: number;

  @IsString()
  @Length(1, 1024)
  path!: string;
}

export class DeleteFileDto extends ChangeOperationDto {
  @Equals('deleteFile')
  type!: 'deleteFile';

  @ApiProperty(entityId)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  fileId!: number;
}

export class SetEntrypointDto extends ChangeOperationDto {
  @Equals('setEntrypoint')
  type!: 'setEntrypoint';

  /** Path in the final tree, including a file created in this batch. */
  @IsString()
  @Length(1, 1024)
  path!: string;
}

export class UpdateContextDto extends ChangeOperationDto {
  @Equals('updateContext')
  type!: 'updateContext';

  @IsString()
  content!: string;
}

export class AttachFileDto extends ChangeOperationDto {
  @Equals('attachFile')
  type!: 'attachFile';

  @IsString()
  @Length(1, 1024)
  path!: string;

  @ApiProperty(entityId)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  uploadId!: number;
}

export class ReplaceFileDto extends ChangeOperationDto {
  @Equals('replaceFile')
  type!: 'replaceFile';

  @ApiProperty(entityId)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  fileId!: number;

  @ApiProperty(entityId)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  uploadId!: number;
}

const changeOperationTypes = [
  { name: 'attachFile', value: AttachFileDto },
  { name: 'replaceFile', value: ReplaceFileDto },
  { name: 'createFile', value: CreateTextFileDto },
  { name: 'updateText', value: UpdateTextDto },
  { name: 'renameFile', value: RenameFileDto },
  { name: 'deleteFile', value: DeleteFileDto },
  { name: 'setEntrypoint', value: SetEntrypointDto },
  { name: 'updateContext', value: UpdateContextDto },
];
export const changeOperationModels = changeOperationTypes.map(({ value }) => value);
export type TextChangeDto =
  | AttachFileDto
  | ReplaceFileDto
  | CreateTextFileDto
  | UpdateTextDto
  | RenameFileDto
  | DeleteFileDto
  | SetEntrypointDto
  | UpdateContextDto;

export class ProjectChangesDto {
  @ApiProperty(entityId)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  baseRevisionId!: number;

  /** Optional summary recorded with the accepted revision. */
  @ApiPropertyOptional({ example: 'Оновлено вступ документа' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 500)
  @Matches(/^\P{Cc}+$/u)
  summary?: string;

  @ApiProperty({
    type: 'array',
    minItems: 1,
    maxItems: MAX_CHANGE_OPERATIONS,
    items: {
      oneOf: changeOperationModels.map((model) => ({ $ref: getSchemaPath(model) })),
      discriminator: {
        propertyName: 'type',
        mapping: Object.fromEntries(
          changeOperationTypes.map(({ name, value }) => [name, getSchemaPath(value)]),
        ),
      },
    },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CHANGE_OPERATIONS)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(
    (options) => {
      // class-transformer reads the discriminator before class-validator runs.
      // Guard malformed array entries before that lookup can dereference null.
      const values: unknown = options?.object?.operations;
      if (
        options?.property === 'operations' &&
        Array.isArray(values) &&
        values.some(
          (value: unknown) => value === null || typeof value !== 'object' || Array.isArray(value),
        )
      )
        throw new BadRequestException(['Every operation must be a non-null object']);
      return ChangeOperationDto;
    },
    {
      discriminator: {
        property: 'type',
        subTypes: changeOperationTypes,
      },
      keepDiscriminatorProperty: true,
    },
  )
  operations!: TextChangeDto[];
}

export class CreatedProjectFileDto {
  @ApiProperty(entityId)
  fileId!: number;
  path!: string;
}

export class ProjectChangesResultDto extends ProjectCreatedDto {
  createdFiles!: CreatedProjectFileDto[];
}

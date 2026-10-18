import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class ValidationFixtureDto {
  /** A short title for the validation fixture. */
  @IsString()
  @MaxLength(20)
  title!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];
}

import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_ENTITY_ID } from '../../../common/ids/numeric-id';
import type { User } from '../infrastructure/persistence/entities/user.entity';

export class EmailDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class CredentialsDto extends EmailDto {
  @IsString()
  @Length(6, 128)
  password!: string;
}

export class LoginDto extends EmailDto {
  @IsString()
  @Length(1, 128)
  password!: string;
}

export class GoogleCredentialDto {
  /** The credential returned by the Google Identity Services JavaScript callback. */
  @IsString()
  @Length(1, 8192)
  idToken!: string;
}

export class TokenDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}

export class ResetPasswordDto extends TokenDto {
  @IsString()
  @Length(6, 128)
  password!: string;
}

export class MessageDto {
  message!: string;
}

export class UserDto {
  @ApiProperty({ type: 'integer', format: 'int32', minimum: 1, maximum: MAX_ENTITY_ID })
  id!: number;
  email!: string;
  emailVerified!: boolean;
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class LoginResponseDto {
  accessToken!: string;
  tokenType!: 'Bearer';
  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
  user!: UserDto;
}

export function userDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: user.createdAt.toISOString(),
  };
}

import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { entityIdSchema } from '../../../common/http/entity-id-schema';
import type { User } from '../infrastructure/persistence/entities/user.entity';

export class EmailDto {
  @ApiProperty({ example: 'user@example.com', format: 'email' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class CredentialsDto extends EmailDto {
  @ApiProperty({ example: 'DemoPassword123!', format: 'password' })
  @IsString()
  @Length(6, 128)
  password!: string;
}

export class LoginDto extends EmailDto {
  @ApiProperty({ example: 'DemoPassword123!', format: 'password' })
  @IsString()
  @Length(1, 128)
  password!: string;
}

export class GoogleCredentialDto {
  /** The credential returned by the Google Identity Services JavaScript callback. */
  @ApiProperty({
    example: 'paste-google-id-token-from-browser',
    description: 'Replace this placeholder with the real Google Identity Services credential.',
  })
  @IsString()
  @Length(1, 8192)
  idToken!: string;
}

export class TokenDto {
  @ApiProperty({
    example: 'A'.repeat(43),
    description:
      'Example format only. Paste the actual single-use token from the confirmation or password-reset email.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}

export class ResetPasswordDto extends TokenDto {
  @ApiProperty({ example: 'DemoPassword123!', format: 'password' })
  @IsString()
  @Length(6, 128)
  password!: string;
}

export class MessageDto {
  message!: string;
}

export class UpdateProfileDto {
  /** Non-empty display name. Email and authentication providers are not editable. */
  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 80)
  @Matches(/^\P{Cc}+$/u)
  name!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @Length(1, 128)
  currentPassword!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @Length(6, 128)
  newPassword!: string;
}

export class UserDto {
  @ApiProperty({ type: String, nullable: true })
  name!: string | null;
  @ApiProperty(entityIdSchema)
  id!: number;
  email!: string;
  emailVerified!: boolean;
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AccountDto extends UserDto {
  /** Whether the account has a password. Does not expose provider identities. */
  hasPassword!: boolean;
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
    name: user.name ?? null,
    email: user.email,
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: user.createdAt.toISOString(),
  };
}

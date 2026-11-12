import { Body, Controller, Get, HttpCode, Patch, Post, Req, UseInterceptors } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiBearerAuth,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { AccountService } from '../application/account.service';
import { IdentityService } from '../application/identity.service';
import { SessionService } from '../application/session.service';
import { ChallengeKind } from '../infrastructure/persistence/entities/identity-challenge.entity';
import { EMAIL_RESEND_COOLDOWN_SECONDS } from '../domain/identity-policy';
import { Public, VerifiedRequired } from './auth-policy';
import type { AuthRequest } from './auth-request';
import {
  AccountDto,
  ChangePasswordDto,
  UpdateProfileDto,
  CredentialsDto,
  EmailDto,
  LoginDto,
  LoginResponseDto,
  MessageDto,
  ResetPasswordDto,
  TokenDto,
  userDto,
} from './identity.dto';
import { NoStoreInterceptor } from './no-store.interceptor';

const accepted = {
  message: `If this address is eligible, an email will be sent. You can request another link after ${EMAIL_RESEND_COOLDOWN_SECONDS / 60} minutes.`,
};

@ApiTags('Identity')
@Public()
@UseInterceptors(NoStoreInterceptor)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@Controller('auth')
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
  ) {}

  /** Register an account and send a confirmation email. Always returns a generic response. */
  @Post('register')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async register(@Body() dto: CredentialsDto): Promise<MessageDto> {
    await this.identity.register(dto.email, dto.password);
    return accepted;
  }

  /** Sign in after confirming your email and receive one Bearer access token. */
  @Post('login')
  @HttpCode(200)
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'EMAIL_NOT_VERIFIED: confirm your email before signing in.',
  })
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(@Body() dto: LoginDto, @Req() request: AuthRequest): Promise<LoginResponseDto> {
    const result = await this.identity.login(
      dto.email,
      dto.password,
      request.get('user-agent') ?? '',
    );
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresAt: result.session.expiresAt.toISOString(),
      user: userDto(result.user),
    };
  }

  /** Return the current account, including its email confirmation status. */
  @Get('me')
  @VerifiedRequired()
  @ApiBearerAuth('bearer')
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  me(@Req() request: AuthRequest): Promise<AccountDto> {
    return this.accounts.profile(request.identity!);
  }

  /** Edit the current user's display name. Email and Google identity remain unchanged. */
  @Patch('me')
  @VerifiedRequired()
  @ApiBearerAuth('bearer')
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  updateProfile(@Body() dto: UpdateProfileDto, @Req() request: AuthRequest): Promise<AccountDto> {
    return this.accounts.update(request.identity!, dto.name);
  }

  /** Change a password after checking the current one. All sessions are revoked. */
  @Post('change-password')
  @HttpCode(204)
  @VerifiedRequired()
  @ApiBearerAuth('bearer')
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async changePassword(@Body() dto: ChangePasswordDto, @Req() request: AuthRequest): Promise<void> {
    await this.accounts.changePassword(request.identity!, dto.currentPassword, dto.newPassword);
  }

  /** Send an account deletion link to the current verified email. No deletion occurs yet. */
  @Post('request-account-deletion')
  @HttpCode(202)
  @VerifiedRequired()
  @ApiBearerAuth('bearer')
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async requestDeletion(@Req() request: AuthRequest): Promise<MessageDto> {
    await this.identity.requestAccountDeletion(request.identity!);
    return accepted;
  }

  /** Permanently delete an account after an explicit confirmation with its single-use email token. */
  @Post('delete-account')
  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async deleteAccount(@Body() dto: TokenDto): Promise<void> {
    await this.accounts.deleteAccount(dto.token);
  }

  /** Revoke the current Bearer access token. */
  @Post('logout')
  @HttpCode(204)
  @VerifiedRequired()
  @ApiBearerAuth('bearer')
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  async logout(@Req() request: AuthRequest): Promise<void> {
    await this.sessions.revoke(request.identity!.user.id, request.identity!.session.id);
  }

  /** Request another confirmation email. Does not disclose whether an account exists. */
  @Post('resend-verification')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async resend(@Body() dto: EmailDto): Promise<MessageDto> {
    await this.identity.sendChallenge(dto.email, ChallengeKind.VerifyEmail);
    return accepted;
  }

  /** Confirm the email using a single-use token from the email. Sign in again afterwards. */
  @Post('verify-email')
  @HttpCode(200)
  async verify(@Body() dto: TokenDto): Promise<MessageDto> {
    await this.identity.consumeChallenge(dto.token, ChallengeKind.VerifyEmail);
    return { message: 'Email confirmed. Sign in to continue.' };
  }

  /** Request a password reset email. Does not disclose whether an account exists. */
  @Post('forgot-password')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async forgot(@Body() dto: EmailDto): Promise<MessageDto> {
    await this.identity.sendChallenge(dto.email, ChallengeKind.ResetPassword);
    return accepted;
  }

  /** Set a new password using a single-use token. All existing sessions are revoked. */
  @Post('reset-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async reset(@Body() dto: ResetPasswordDto): Promise<MessageDto> {
    await this.identity.consumeChallenge(dto.token, ChallengeKind.ResetPassword, dto.password);
    return { message: 'Password changed. Sign in to continue.' };
  }
}

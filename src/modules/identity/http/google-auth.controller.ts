import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnsupportedMediaTypeException,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { GoogleAuthService } from '../application/google-auth.service';
import { Public, VerifiedRequired } from './auth-policy';
import type { AuthRequest } from './auth-request';
import { GoogleCredentialDto, LoginResponseDto, MessageDto, userDto } from './identity.dto';
import { NoStoreInterceptor } from './no-store.interceptor';

@ApiTags('Identity')
@ApiConsumes('application/json')
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiConflictResponse({ type: ErrorResponseDto })
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@ApiUnsupportedMediaTypeResponse({ type: ErrorResponseDto })
@Public()
@UseInterceptors(NoStoreInterceptor)
@Controller('auth/google')
export class GoogleAuthController {
  constructor(private readonly google: GoogleAuthService) {}

  /** Sign in or register using a Google Identity Services credential. Returns a Typstoria token. */
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(
    @Body() dto: GoogleCredentialDto,
    @Req() request: AuthRequest,
  ): Promise<LoginResponseDto> {
    this.requireJson(request);
    const result = await this.google.login(dto.idToken, request.get('user-agent') ?? '');
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresAt: result.session.expiresAt.toISOString(),
      user: userDto(result.user),
    };
  }

  /** Link a matching Google account after signing in to a verified Typstoria account. */
  @Post('link')
  @HttpCode(200)
  @VerifiedRequired()
  @ApiBearerAuth('bearer')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async link(@Body() dto: GoogleCredentialDto, @Req() request: AuthRequest): Promise<MessageDto> {
    this.requireJson(request);
    await this.google.link(request.identity!.user.id, dto.idToken);
    return { message: 'Google account linked.' };
  }

  private requireJson(request: AuthRequest): void {
    // GIS callback -> same-origin JSON fetch. Direct cross-site form POST is not supported.
    if (!request.is('application/json')) {
      throw new UnsupportedMediaTypeException('Send Google credentials as application/json');
    }
  }
}

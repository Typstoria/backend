import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionService } from '../application/session.service';
import { AUTH_POLICY, AuthPolicy } from './auth-policy';
import { AuthRequest, readBearerToken } from './auth-request';
import type { Response } from 'express';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy =
      this.reflector.getAllAndOverride<AuthPolicy>(AUTH_POLICY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'verified';
    // Public routes (including health) do not need a token or a session lookup.
    if (policy === 'public') return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    request.identity = await this.sessions.resolve(readBearerToken(request));
    if (!request.identity) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('WWW-Authenticate', 'Bearer realm="Typstoria"');
      throw new UnauthorizedException('A valid Bearer access token is required');
    }
    if (request.identity) {
      request.actor = {
        userId: request.identity.user.id,
        channel: 'web',
        credentialId: request.identity.session.id,
        scopes: [],
        projectIds: null,
      };
    }
    if (policy === 'verified' && !request.identity.user.emailVerifiedAt) {
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Confirm your email to continue',
      });
    }
    return true;
  }
}

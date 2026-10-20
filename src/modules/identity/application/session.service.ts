import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseEntityId } from '../../../common/ids/numeric-id';
import { AppConfigService } from '../../../config/app-config.service';
import { createToken, hashToken, matchesToken } from '../domain/tokens';
import { User } from '../infrastructure/persistence/entities/user.entity';
import { WebSession } from '../infrastructure/persistence/entities/web-session.entity';

@Injectable()
export class SessionService {
  constructor(
    private readonly database: DataSource,
    private readonly config: AppConfigService,
  ) {}

  async create(
    user: User,
    userAgent: string,
  ): Promise<{ session: WebSession; accessToken: string }> {
    const secret = createToken();
    const session = await this.database.transaction(async (manager) => {
      const current = await manager.findOne(User, {
        where: { id: user.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current || current.authVersion !== user.authVersion) {
        throw new UnauthorizedException({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        });
      }
      if (!current.emailVerifiedAt) {
        throw new ForbiddenException({
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Confirm your email before signing in',
        });
      }
      return manager.save(
        WebSession,
        manager.create(WebSession, {
          userId: user.id,
          secretHash: hashToken(secret),
          authVersion: user.authVersion,
          userAgent: userAgent.slice(0, 256),
          expiresAt: new Date(Date.now() + this.config.accessTokenTtlSeconds * 1000),
        }),
      );
    });
    return { session, accessToken: `${session.id}.${secret}` };
  }

  async resolve(
    accessToken: string | undefined,
  ): Promise<{ user: User; session: WebSession } | undefined> {
    const match = /^([1-9][0-9]{0,9})\.([A-Za-z0-9_-]{43})$/.exec(accessToken ?? '');
    if (!match) return;
    const id = parseEntityId(match[1]!);
    if (id === undefined) return;
    const secret = match[2]!;
    const session = await this.database
      .getRepository(WebSession)
      .createQueryBuilder('session')
      .addSelect('session.secretHash')
      .innerJoinAndSelect('session.user', 'user')
      .where('session.id = :id', { id })
      .getOne();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.authVersion !== session.user.authVersion ||
      !matchesToken(secret, session.secretHash)
    )
      return;
    return { user: session.user, session };
  }

  async revoke(userId: number, sessionId: number): Promise<void> {
    const result = await this.database
      .getRepository(WebSession)
      .update({ id: sessionId, userId }, { revokedAt: new Date() });
    if (!result.affected) throw new NotFoundException('Session not found');
  }
}

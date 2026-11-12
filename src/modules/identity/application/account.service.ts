import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { User } from '../infrastructure/persistence/entities/user.entity';
import { WebSession } from '../infrastructure/persistence/entities/web-session.entity';
import {
  ChallengeKind,
  IdentityChallenge,
} from '../infrastructure/persistence/entities/identity-challenge.entity';
import { PasswordHasher } from '../infrastructure/password-hasher.service';
import { hashToken } from '../domain/tokens';
import type { AuthRequest } from '../http/auth-request';
import type { AccountDto } from '../http/identity.dto';
import { userDto } from '../http/identity.dto';

type Identity = NonNullable<AuthRequest['identity']>;

@Injectable()
export class AccountService {
  constructor(
    private readonly database: DataSource,
    private readonly passwords: PasswordHasher,
  ) {}

  async profile(identity: Identity): Promise<AccountDto> {
    return this.database.transaction(async (manager) => {
      const user = await this.current(manager, identity);
      return { ...userDto(user), hasPassword: user.passwordHash !== null };
    });
  }

  async update(identity: Identity, name: string): Promise<AccountDto> {
    return this.database.transaction(async (manager) => {
      const user = await this.current(manager, identity);
      user.name = name;
      await manager.save(user);
      return { ...userDto(user), hasPassword: user.passwordHash !== null };
    });
  }

  async changePassword(
    identity: Identity,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const hash = await this.passwords.hash(newPassword);
    await this.database.transaction(async (manager) => {
      const user = await this.current(manager, identity);
      if (!user.passwordHash)
        throw new ForbiddenException({
          code: 'PASSWORD_NOT_SET',
          message: 'This account has no password',
        });
      if (!(await this.passwords.verify(currentPassword, user.passwordHash)))
        throw new BadRequestException({
          code: 'CURRENT_PASSWORD_INVALID',
          message: 'Current password is incorrect',
        });
      user.passwordHash = hash;
      user.authVersion += 1;
      await manager.save(user);
      // A previous reset/deletion link must not undo a newly confirmed password change.
      await manager.update(
        IdentityChallenge,
        { userId: user.id, consumedAt: IsNull() },
        { consumedAt: new Date() },
      );
    });
  }

  async deleteAccount(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    const candidate = await this.database
      .getRepository(IdentityChallenge)
      .findOneBy({ tokenHash, kind: ChallengeKind.DeleteAccount });
    if (!candidate) throw this.invalidToken();
    await this.database.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: candidate.userId },
        lock: { mode: 'pessimistic_write' },
      });
      const challenge = await manager.findOneBy(IdentityChallenge, {
        id: candidate.id,
        tokenHash,
        kind: ChallengeKind.DeleteAccount,
      });
      if (
        !user ||
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= Date.now()
      )
        throw this.invalidToken();
      // Database FKs remove owned projects, snapshots, jobs, sessions and challenges atomically.
      // Immutable bytes/repositories are inaccessible after commit; physical GC is deferred.
      await manager.delete(User, { id: user.id });
    });
  }

  private async current(manager: EntityManager, identity: Identity): Promise<User> {
    const user = await manager.findOne(User, {
      where: { id: identity.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        normalizedEmail: true,
        emailVerifiedAt: true,
        authVersion: true,
        createdAt: true,
        updatedAt: true,
        passwordHash: true,
      },
      lock: { mode: 'pessimistic_write' },
    });
    const session = await manager.findOneBy(WebSession, {
      id: identity.session.id,
      userId: identity.user.id,
    });
    if (
      !user ||
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.authVersion !== user.authVersion
    )
      throw new UnauthorizedException('A valid Bearer access token is required');
    return user;
  }

  private invalidToken() {
    return new BadRequestException({
      code: 'INVALID_OR_EXPIRED_TOKEN',
      message: 'The link is invalid, expired or already used',
    });
  }
}

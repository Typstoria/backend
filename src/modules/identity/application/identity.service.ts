import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { AppConfigService } from '../../../config/app-config.service';
import {
  IdentityMailDeliveryError,
  IdentityMailer,
} from '../../../infrastructure/mail/identity-mailer';
import { createToken, hashToken, normalizeEmail } from '../domain/tokens';
import { EMAIL_RESEND_COOLDOWN_SECONDS } from '../domain/identity-policy';
import { PasswordHasher } from '../infrastructure/password-hasher.service';
import { createIdentityEmail } from '../infrastructure/mail/identity-email';
import {
  ChallengeKind,
  IdentityChallenge,
} from '../infrastructure/persistence/entities/identity-challenge.entity';
import { User } from '../infrastructure/persistence/entities/user.entity';
import { WebSession } from '../infrastructure/persistence/entities/web-session.entity';
import { SessionService } from './session.service';

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  constructor(
    private readonly database: DataSource,
    private readonly passwords: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly config: AppConfigService,
    private readonly mailer: IdentityMailer,
  ) {}

  async register(email: string, password: string): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    const normalizedEmail = normalizeEmail(email);
    // A duplicate registration never replaces the existing account's password.
    await this.database
      .getRepository(User)
      .createQueryBuilder()
      .insert()
      .values({
        email: email.trim(),
        normalizedEmail,
        passwordHash,
      })
      .orIgnore()
      .execute();
    await this.sendChallenge(normalizedEmail, ChallengeKind.VerifyEmail);
  }

  async login(email: string, password: string, userAgent: string) {
    const user = await this.database
      .getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.normalizedEmail = :email', { email: normalizeEmail(email) })
      .getOne();
    const valid = await this.passwords.verify(password, user?.passwordHash);
    if (!valid || !user) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }
    const result = await this.sessions.create(user, userAgent);
    return { ...result, user };
  }

  async sendChallenge(email: string, kind: ChallengeKind): Promise<void> {
    const mail = await this.database.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { normalizedEmail: normalizeEmail(email) },
        select: { id: true, email: true, emailVerifiedAt: true, passwordHash: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !user ||
        (kind === ChallengeKind.VerifyEmail && user.emailVerifiedAt) ||
        (kind === ChallengeKind.ResetPassword && !user.passwordHash)
      )
        return;
      const latest = await manager.findOne(IdentityChallenge, {
        where: { userId: user.id, kind },
        order: { createdAt: 'DESC' },
      });
      if (latest && Date.now() - latest.createdAt.getTime() < EMAIL_RESEND_COOLDOWN_SECONDS * 1000)
        return;
      const token = createToken();
      const ttl =
        kind === ChallengeKind.VerifyEmail
          ? this.config.verifyTtlSeconds
          : this.config.resetTtlSeconds;
      await manager.update(
        IdentityChallenge,
        { userId: user.id, kind, consumedAt: IsNull() },
        { consumedAt: new Date() },
      );
      await manager.save(
        IdentityChallenge,
        manager.create(IdentityChallenge, {
          userId: user.id,
          kind,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + ttl * 1000),
        }),
      );
      const verification = kind === ChallengeKind.VerifyEmail;
      const link = `${this.config.publicWebUrl}/auth/${verification ? 'verify-email' : 'reset-password'}#token=${token}`;
      return createIdentityEmail({
        to: user.email,
        kind,
        link,
        ttlSeconds: ttl,
      });
    });
    if (mail) {
      try {
        await this.mailer.send(mail);
      } catch (error) {
        // Never log provider payloads, recipients, tokens or API credentials.
        this.logger.error({
          message: 'Identity email delivery failed',
          kind,
          ...(error instanceof IdentityMailDeliveryError
            ? { reason: error.reason, httpStatus: error.httpStatus }
            : { reason: 'transport_error' }),
        });
      }
    }
  }

  async consumeChallenge(token: string, kind: ChallengeKind, password?: string): Promise<number> {
    const tokenHash = hashToken(token);
    const candidate = await this.database
      .getRepository(IdentityChallenge)
      .findOneBy({ tokenHash, kind });
    if (!candidate) throw this.invalidToken();
    const passwordHash = password === undefined ? undefined : await this.passwords.hash(password);
    return this.database.transaction(async (manager) => {
      // All identity mutations lock the user first, including login, issuance and reset.
      const user = await manager.findOne(User, {
        where: { id: candidate.userId },
        lock: { mode: 'pessimistic_write' },
      });
      const challenge = await manager.findOneBy(IdentityChallenge, {
        id: candidate.id,
        tokenHash,
        kind,
      });
      if (
        !user ||
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= Date.now()
      )
        throw this.invalidToken();
      if (kind === ChallengeKind.VerifyEmail) user.emailVerifiedAt = new Date();
      else {
        if (!passwordHash) throw this.invalidToken();
        user.passwordHash = passwordHash;
      }
      user.authVersion += 1;
      await manager.save(user);
      await manager.update(
        IdentityChallenge,
        { userId: user.id, kind, consumedAt: IsNull() },
        { consumedAt: new Date() },
      );
      await manager.update(
        WebSession,
        { userId: user.id, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
      return user.id;
    });
  }

  private invalidToken(): BadRequestException {
    return new BadRequestException({
      code: 'INVALID_OR_EXPIRED_TOKEN',
      message: 'The link is invalid, expired or already used',
    });
  }
}

import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { normalizeEmail } from '../domain/tokens';
import { GoogleTokenVerifier } from '../infrastructure/google-token-verifier';
import { User } from '../infrastructure/persistence/entities/user.entity';
import { SessionService } from './session.service';

@Injectable()
export class GoogleAuthService {
  constructor(
    private readonly database: DataSource,
    private readonly verifier: GoogleTokenVerifier,
    private readonly sessions: SessionService,
  ) {}

  async login(idToken: string, userAgent: string) {
    const profile = await this.verifier.verify(idToken);
    const users = this.database.getRepository(User);
    let user = await users.findOneBy({ googleSubject: profile.subject });
    if (!user) {
      // Unique email and Google subject constraints arbitrate concurrent first sign-ins.
      await users
        .createQueryBuilder()
        .insert()
        .values({
          email: profile.email,
          normalizedEmail: normalizeEmail(profile.email),
          googleSubject: profile.subject,
          passwordHash: null,
          emailVerifiedAt: new Date(),
        })
        .orIgnore()
        .execute();
      user = await users.findOneBy({ googleSubject: profile.subject });
      if (!user) {
        throw new ConflictException({
          code: 'GOOGLE_ACCOUNT_LINK_REQUIRED',
          message: 'Sign in to your existing account before linking Google',
        });
      }
    }
    const result = await this.sessions.create(user, userAgent);
    return { ...result, user };
  }

  async link(userId: number, idToken: string): Promise<void> {
    const profile = await this.verifier.verify(idToken);
    try {
      await this.database.transaction(async (manager) => {
        const user = await manager.findOne(User, {
          where: { id: userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !user?.emailVerifiedAt ||
          user.normalizedEmail !== normalizeEmail(profile.email) ||
          (user.googleSubject !== null && user.googleSubject !== profile.subject)
        ) {
          throw this.linkConflict();
        }
        user.googleSubject = profile.subject;
        await manager.save(user);
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === '23505'
      ) {
        throw this.linkConflict();
      }
      throw error;
    }
  }

  private linkConflict(): ConflictException {
    return new ConflictException({
      code: 'GOOGLE_ACCOUNT_LINK_CONFLICT',
      message: 'This Google account cannot be linked to the current account',
    });
  }
}

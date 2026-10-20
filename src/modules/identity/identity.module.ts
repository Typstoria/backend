import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IdentityMailer } from '../../infrastructure/mail/identity-mailer';
import { MailjetIdentityMailer } from '../../infrastructure/mail/mailjet-identity-mailer';
import { IdentityService } from './application/identity.service';
import { GoogleAuthService } from './application/google-auth.service';
import { SessionService } from './application/session.service';
import { SessionGuard } from './http/auth.guards';
import { IdentityController } from './http/identity.controller';
import { GoogleAuthController } from './http/google-auth.controller';
import { GoogleTokenVerifier } from './infrastructure/google-token-verifier';
import { PasswordHasher } from './infrastructure/password-hasher.service';
import { IdentityChallenge } from './infrastructure/persistence/entities/identity-challenge.entity';
import { User } from './infrastructure/persistence/entities/user.entity';
import { WebSession } from './infrastructure/persistence/entities/web-session.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, WebSession, IdentityChallenge]),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
  ],
  controllers: [IdentityController, GoogleAuthController],
  providers: [
    PasswordHasher,
    IdentityService,
    GoogleAuthService,
    GoogleTokenVerifier,
    SessionService,
    { provide: IdentityMailer, useClass: MailjetIdentityMailer },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class IdentityModule {}

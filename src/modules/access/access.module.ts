import { IdentityModule } from '../identity/identity.module';
import { OAuthService } from './oauth.service';
import { Module } from '@nestjs/common';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';

@Module({
  imports: [IdentityModule],
  controllers: [AccessController],
  providers: [AccessService, OAuthService],
  exports: [AccessService, OAuthService],
})
export class AccessModule {}

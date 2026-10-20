import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { AppConfigService } from '../../../config/app-config.service';

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(254),
  email_verified: z.literal(true),
  iss: z.enum(['accounts.google.com', 'https://accounts.google.com']),
  aud: z.string(),
  exp: z.number().int(),
});

export interface GoogleProfile {
  subject: string;
  email: string;
}

@Injectable()
export class GoogleTokenVerifier {
  private readonly client = new OAuth2Client({ transporterOptions: { timeout: 10000 } });

  constructor(private readonly config: AppConfigService) {}

  async verify(idToken: string): Promise<GoogleProfile> {
    const audience = this.config.googleClientId;
    if (!audience) {
      throw new ServiceUnavailableException({
        code: 'GOOGLE_AUTH_NOT_CONFIGURED',
        message: 'Google sign-in is not configured',
      });
    }
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience });
      const claims = claimsSchema.parse(ticket.getPayload());
      // Enforce exact expiry, including the library's allowed clock-skew window.
      if (claims.aud !== audience || claims.exp <= Date.now() / 1000) throw new Error();
      return { subject: claims.sub, email: claims.email };
    } catch {
      // Library errors may include the credential or its decoded claims.
      throw new UnauthorizedException({
        code: 'GOOGLE_TOKEN_INVALID',
        message: 'Invalid or expired Google credential',
      });
    }
  }
}

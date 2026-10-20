import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { IdentityMailDeliveryError, IdentityMailer } from './identity-mailer';
import type { IdentityMail } from './identity-mailer';

@Injectable()
export class MailjetIdentityMailer extends IdentityMailer {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  async send(mail: IdentityMail): Promise<void> {
    // Fixed HTTPS endpoint: credentials can never be redirected to a configured host.
    const response = await fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.mailjetApiKey}:${this.config.mailjetSecretKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Messages: [
          {
            From: { Email: this.config.mailFrom, Name: 'Typstoria' },
            To: [{ Email: mail.to }],
            Subject: mail.subject,
            TextPart: mail.text,
            HTMLPart: mail.html,
            TrackOpens: 'disabled',
            TrackClicks: 'disabled',
          },
        ],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new IdentityMailDeliveryError(
        response.status === 401 ? 'authentication_failed' : 'request_rejected',
        response.status,
      );
    }
    const payload: unknown = await response.json();
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('Messages' in payload) ||
      !Array.isArray(payload.Messages) ||
      payload.Messages.length !== 1 ||
      (payload.Messages[0] as { Status?: unknown } | undefined)?.Status !== 'success'
    ) {
      throw new IdentityMailDeliveryError('message_rejected', response.status);
    }
  }
}

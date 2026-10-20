export interface IdentityMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export abstract class IdentityMailer {
  abstract send(mail: IdentityMail): Promise<void>;
}

export class IdentityMailDeliveryError extends Error {
  constructor(
    readonly reason: 'authentication_failed' | 'request_rejected' | 'message_rejected',
    readonly httpStatus: number,
  ) {
    super('Mailjet delivery failed');
    this.name = 'IdentityMailDeliveryError';
  }
}

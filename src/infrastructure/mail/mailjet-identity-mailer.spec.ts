import { AppConfigService } from '../../config/app-config.service';
import { IdentityMailDeliveryError } from './identity-mailer';
import { MailjetIdentityMailer } from './mailjet-identity-mailer';

describe('Mailjet transport', () => {
  const mail = {
    to: 'person@example.test',
    subject: 'Confirm email',
    text: 'Private link',
    html: '<p>Private link</p>',
  };
  const config = {
    mailFrom: 'sender@example.test',
    mailjetApiKey: 'public-test-key',
    mailjetSecretKey: 'private-test-key',
  } as AppConfigService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('uses the Mailjet Send API and disables tracking on security links', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ Messages: [{ Status: 'success' }] }), { status: 200 }),
    );
    await new MailjetIdentityMailer(config).send(mail);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mailjet.com/v3.1/send');
    expect(options.redirect).toBe('error');
    expect(options.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('public-test-key:private-test-key').toString('base64')}`,
    });
    expect(JSON.parse(options.body as string)).toEqual({
      Messages: [
        {
          From: { Email: 'sender@example.test', Name: 'Typstoria' },
          To: [{ Email: mail.to }],
          Subject: mail.subject,
          TextPart: mail.text,
          HTMLPart: mail.html,
          TrackOpens: 'disabled',
          TrackClicks: 'disabled',
        },
      ],
    });
  });

  it.each([
    { status: 401, payload: { ErrorMessage: 'private provider diagnostics' } },
    {
      status: 200,
      payload: { Messages: [{ Status: 'error', Errors: ['private provider diagnostics'] }] },
    },
    { status: 200, payload: {} },
  ])(
    'rejects unsuccessful delivery without exposing provider details: $status',
    async ({ status, payload }) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status }));
      await expect(new MailjetIdentityMailer(config).send(mail)).rejects.toThrow(
        /^Mailjet delivery failed$/,
      );
    },
  );

  it('reports authentication failures safely even when Mailjet returns HTML', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>private provider diagnostics</html>', { status: 401 }),
    );
    await expect(new MailjetIdentityMailer(config).send(mail)).rejects.toMatchObject({
      name: 'IdentityMailDeliveryError',
      message: 'Mailjet delivery failed',
      reason: 'authentication_failed',
      httpStatus: 401,
    } satisfies Partial<IdentityMailDeliveryError>);
  });

  it('distinguishes provider rejection from invalid credentials', async () => {
    fetchMock.mockResolvedValue(new Response('private provider diagnostics', { status: 403 }));
    await expect(new MailjetIdentityMailer(config).send(mail)).rejects.toMatchObject({
      reason: 'request_rejected',
      httpStatus: 403,
    });
  });
});

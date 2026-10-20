import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { AppConfigService } from '../../../config/app-config.service';
import { GoogleTokenVerifier } from './google-token-verifier';

describe('Google credential verification with real JWT signatures and local test keys', () => {
  const clientId = 'test-client.apps.googleusercontent.com';
  let privateKey: KeyObject;
  let publicKey: string;
  let certs: jest.SpyInstance;
  const verifier = () => new GoogleTokenVerifier({ googleClientId: clientId } as AppConfigService);

  beforeAll(() => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });
  beforeEach(() => {
    certs = jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
      certs: { 'test-key': publicKey },
      format: 'PEM' as Awaited<ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>>['format'],
    });
  });
  afterEach(() => jest.restoreAllMocks());

  function jwt(overrides: Record<string, unknown> = {}, key = privateKey): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: '123456789',
        email: 'identity@example.test',
        email_verified: true,
        iat: now - 5,
        exp: now + 3600,
        ...overrides,
      }),
    ).toString('base64url');
    const data = `${header}.${payload}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
  }

  it('verifies the signature and returns only the verified subject and email', async () => {
    await expect(verifier().verify(jwt())).resolves.toEqual({
      subject: '123456789',
      email: 'identity@example.test',
    });
  });

  it.each([
    { aud: 'another-client.apps.googleusercontent.com' },
    { iss: 'https://attacker.example' },
    { email_verified: false },
    { email: 'invalid' },
    { sub: '' },
    { exp: 1 },
  ])('rejects an invalid signed claim: %j', async (claims) => {
    await expect(verifier().verify(jwt(claims))).rejects.toMatchObject({
      response: { code: 'GOOGLE_TOKEN_INVALID' },
    });
  });

  it('rejects expiry even inside the Google library clock-skew allowance', async () => {
    await expect(
      verifier().verify(jwt({ exp: Math.floor(Date.now() / 1000) - 1 })),
    ).rejects.toMatchObject({ response: { code: 'GOOGLE_TOKEN_INVALID' } });
  });

  it('rejects a forged signature', async () => {
    const forgedKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(verifier().verify(jwt({}, forgedKey))).rejects.toMatchObject({
      response: { code: 'GOOGLE_TOKEN_INVALID' },
    });
  });

  it('does not leak credentials or provider errors', async () => {
    certs.mockRejectedValueOnce(new Error('private token and provider diagnostics'));
    await expect(verifier().verify('private credential')).rejects.toMatchObject({
      message: 'Invalid or expired Google credential',
    });
  });

  it('requires configuration before requesting Google keys', async () => {
    const unconfigured = new GoogleTokenVerifier({ googleClientId: undefined } as AppConfigService);
    await expect(unconfigured.verify('credential')).rejects.toMatchObject({
      response: { code: 'GOOGLE_AUTH_NOT_CONFIGURED' },
    });
    expect(certs).not.toHaveBeenCalled();
  });
});

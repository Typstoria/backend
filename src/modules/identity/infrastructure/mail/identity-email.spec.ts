import { ChallengeKind } from '../persistence/entities/identity-challenge.entity';
import { createIdentityEmail } from './identity-email';

describe('Identity email content', () => {
  const base = {
    to: 'reader@example.test',
    link: 'https://typstoria.example/auth/verify-email#token=example-token',
    kind: ChallengeKind.VerifyEmail,
    ttlSeconds: 86400,
  };

  it('provides a verification action and the same link in HTML and plain text', () => {
    const mail = createIdentityEmail(base);
    expect(mail.html).toContain(`href="${base.link}"`);
    expect(mail.text).toContain(base.link);
    expect(mail.html).toContain('Підтвердити пошту');
    expect(mail.text).toContain('24 години');
    expect(mail.html).not.toContain('1440');
  });

  it('provides a distinct reset action, expiry and reassurance about an unrequested reset', () => {
    const link = 'https://typstoria.example/auth/reset-password#token=reset-token';
    const mail = createIdentityEmail({
      ...base,
      link,
      kind: ChallengeKind.ResetPassword,
      ttlSeconds: 900,
    });
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.text).toContain(link);
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('Створити новий пароль');
      expect(body).toContain('15 хвилин');
      expect(body).toContain('Ваш пароль залишиться без змін.');
      expect(body).not.toContain('Підтвердити пошту');
    }
  });

  it.each([
    [60, '1 хвилину'],
    [120, '2 хвилини'],
    [660, '11 хвилин'],
    [1260, '21 хвилину'],
    [3600, '1 годину'],
    [3601, '1 годину 1 секунду'],
    [5400, '1 годину 30 хвилин'],
  ])('describes a configured TTL of %i seconds without rounding up', (ttlSeconds, expected) => {
    const mail = createIdentityEmail({ ...base, ttlSeconds });
    expect(mail.html).toContain(`Посилання діє ${expected} після надсилання`);
    expect(mail.text).toContain(`Посилання діє ${expected} після надсилання`);
  });

  it('escapes link markup in HTML while keeping the original plain-text URL', () => {
    const link = 'https://typstoria.example/?a=1&label="<test>"#token=example-token';
    const mail = createIdentityEmail({ ...base, link });
    expect(mail.html).toContain('a=1&amp;label=&quot;&lt;test&gt;&quot;#token=example-token');
    expect(mail.html).not.toContain('<test>');
    expect(mail.text).toContain(link);
  });
});

import type { IdentityMail } from '../../../../infrastructure/mail/identity-mailer';
import { ChallengeKind } from '../persistence/entities/identity-challenge.entity';

const plural = new Intl.PluralRules('uk');

function duration(seconds: number): string {
  const units = [
    { size: 3600, forms: ['годину', 'години', 'годин'] },
    { size: 60, forms: ['хвилину', 'хвилини', 'хвилин'] },
    { size: 1, forms: ['секунду', 'секунди', 'секунд'] },
  ];
  let remaining = seconds;
  return units
    .flatMap(({ size, forms }) => {
      const count = Math.floor(remaining / size);
      remaining %= size;
      if (!count) return [];
      const form = plural.select(count);
      return [`${count} ${forms[form === 'one' ? 0 : form === 'few' ? 1 : 2]}`];
    })
    .join(' ');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
}

export function createIdentityEmail(options: {
  to: string;
  kind: ChallengeKind;
  link: string;
  ttlSeconds: number;
}): IdentityMail {
  const verification = options.kind === ChallengeKind.VerifyEmail;
  const title = verification ? 'Підтвердіть вашу пошту' : 'Встановіть новий пароль';
  const action = verification ? 'Підтвердити пошту' : 'Створити новий пароль';
  const introduction = verification
    ? 'Раді бачити вас у Typstoria. Підтвердіть електронну адресу, щоб почати працювати над вашими документами.'
    : 'Ми отримали запит на відновлення доступу до вашого облікового запису Typstoria. Натисніть кнопку нижче, щоб встановити новий пароль.';
  const validity = `Посилання діє ${duration(options.ttlSeconds)} після надсилання та може бути використане лише один раз.`;
  const notice = verification
    ? 'Якщо ви не створювали обліковий запис у Typstoria, просто проігноруйте цей лист. Нічого робити не потрібно.'
    : 'Якщо ви не надсилали цей запит, просто проігноруйте цей лист. Ваш пароль залишиться без змін.';
  const preheader = verification
    ? 'Один крок — і ваш простір для документів готовий.'
    : 'Відновіть доступ до ваших документів у Typstoria.';
  const link = escapeHtml(options.link);

  return {
    to: options.to,
    subject: verification ? 'Підтвердіть вашу пошту — Typstoria' : 'Відновлення пароля — Typstoria',
    text: `${title}\n\n${introduction}\n\n${action}:\n${options.link}\n\n${validity}\n\n${notice}\n\nКоманда Typstoria`,
    html: `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${title} — Typstoria</title>
  <style>
    @media only screen and (max-width: 600px) {
      .outer { padding: 24px 12px !important; }
      .content { padding: 32px 24px !important; }
      .heading { font-size: 30px !important; }
      .action { display: block !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f3f8;color:#242035;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f3f8;">
    <tr><td class="outer" align="center" style="padding:48px 24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
        <tr><td style="padding:0 8px 24px;font-size:24px;font-weight:700;letter-spacing:-0.8px;color:#302345;">Typstoria<span style="color:#7953d2;">.</span></td></tr>
        <tr><td style="background-color:#ffffff;border:1px solid #e6e2ef;border-top:4px solid #7953d2;border-radius:12px;overflow:hidden;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td class="content" style="padding:44px 40px;">
              <p style="margin:0 0 20px;font-size:11px;line-height:18px;font-weight:700;letter-spacing:1.7px;color:#7953d2;">${verification ? 'ЛАСКАВО ПРОСИМО' : 'БЕЗПЕКА ОБЛІКОВОГО ЗАПИСУ'}</p>
              <h1 class="heading" style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:36px;line-height:1.2;font-weight:400;letter-spacing:-0.7px;color:#242035;">${title}</h1>
              <p style="margin:0 0 28px;font-size:16px;line-height:26px;color:#625d70;">${introduction}</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px;width:100%;">
                <tr><td align="left">
                  <!--[if mso]><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#6842bf" style="padding:16px 26px;"><![endif]-->
                  <a class="action" href="${link}" style="display:inline-block;padding:16px 26px;background-color:#6842bf;border:1px solid #6842bf;border-radius:8px;color:#ffffff;font-size:15px;line-height:20px;font-weight:700;text-decoration:none;mso-padding-alt:0;">${action}<span aria-hidden="true"> &rarr;</span></a>
                  <!--[if mso]></td></tr></table><![endif]-->
                </td></tr>
              </table>
              <p style="margin:0 0 28px;padding:16px 18px;background-color:#f6f3fc;border:1px solid #ece5f8;border-radius:8px;font-size:13px;line-height:21px;color:#62527f;">${validity}</p>
              <p style="margin:0 0 28px;font-size:14px;line-height:23px;color:#716b7d;">${notice}</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="border-top:1px solid #eeeaf3;padding-top:24px;">
                  <p style="margin:0 0 8px;font-size:12px;line-height:20px;color:#80798c;">Кнопка не працює? Скопіюйте це посилання в браузер:</p>
                  <p style="margin:0;font-size:12px;line-height:20px;word-break:break-all;overflow-wrap:anywhere;"><a href="${link}" style="color:#6842bf;text-decoration:underline;word-break:break-all;">${link}</a></p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:24px 20px 0;">
          <p style="margin:0 0 6px;font-size:12px;line-height:20px;color:#80798c;">З турботою про ваші документи, команда Typstoria</p>
          <p style="margin:0;font-size:11px;line-height:18px;color:#9790a2;">Це автоматичний лист щодо вашого облікового запису.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
}

# Вхід через Google

Реалізовано 20.10.2026. Google Identity Services передає ID token у JavaScript callback фронтенду; бекенд перевіряє його через офіційну `google-auth-library` і повертає звичайний непрозорий Bearer access token Typstoria. Google Client Secret, refresh token, callback cookies та додаткові контейнери не потрібні. Бекенд не зберігає Google ID/access/refresh tokens і не отримує доступ до Google Drive або інших Google API.

## Налаштування Google Cloud

1. Відкрити [Google Cloud Console](https://console.cloud.google.com/), створити або вибрати проєкт.
2. У Google Auth Platform налаштувати Branding / Audience: назву Typstoria, контактну адресу та дозволену аудиторію. Для зовнішнього застосунку в режимі Testing додати тестові Google-акаунти до Test users.
3. У Clients створити OAuth client типу **Web application**.
4. У **Authorized JavaScript origins** додати адресу фронтенду: локально `http://localhost` і `http://localhost:5173`, у production — його HTTPS origin. Origin, на якому працює фронтенд, також має бути в `CORS_ORIGINS` бекенду. Не вказувати шлях або trailing slash.
5. Скопіювати Client ID у локальний `.env`:

```dotenv
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

6. Перезапустити API. Client ID є публічним і також використовується фронтендом. Client Secret у цій реалізації не використовується. Redirect URI не потрібний: обрано JavaScript callback Google Identity Services, а не redirect/form-post flow.

Якщо Client ID порожній або відсутній, решта API працює, а Google-вхід повертає 503 `GOOGLE_AUTH_NOT_CONFIGURED`. Підроблений Client ID не дозволяє протестувати реальний вхід: `aud` підписаного Google-токена має точно збігатися з налаштованим значенням.

Офіційна інструкція: [створення Google OAuth Client ID](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

## Контракти

| Метод                        | Вхід                                | Результат                                                         |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| `POST /api/auth/google`      | JSON `{idToken}`                    | 200 `{accessToken,tokenType,expiresAt,user}`                      |
| `POST /api/auth/google/link` | JSON `{idToken}` + Bearer Typstoria | 200 `{message}`; потрібен підтверджений локальний обліковий запис |

`idToken` — значення `credential` з Google Identity Services callback. Це не Google access token і не токен Typstoria. Токен передається лише в JSON body, не в URL або заголовку авторизації. Максимальна довжина — 8192 символи. Відповіді мають `Cache-Control: no-store`.

Фронтенд додає офіційний `https://accounts.google.com/gsi/client`, викликає `google.accounts.id.initialize({client_id, callback})`, показує офіційну кнопку й передає `credential` через свій JSON HTTP-клієнт:

```js
google.accounts.id.initialize({
  client_id: GOOGLE_CLIENT_ID,
  callback: async ({ credential }) => {
    const response = await fetch(`${API_URL}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: credential }),
    });
    const result = await response.json();
    // Передати результат у стан авторизації фронтенду.
    // Обробити 409: запропонувати звичайний вхід і явне прив’язування Google.
    handleGoogleResult(response.status, result);
  },
});
google.accounts.id.renderButton(document.getElementById('google-sign-in'), {
  type: 'standard',
  theme: 'outline',
  size: 'large',
});
```

Фронтенд ще не реалізований у цьому backend-репозиторії. Swagger документує JSON endpoint; справжній Google credential потрібно отримати кнопкою GIS на налаштованому frontend origin. Секрети та токени не слід записувати в console/logs.

## Облікові записи та безпека

- Перевіряються криптографічний підпис Google, `iss`, точний `aud`, expiry, непорожній `sub`, email і `email_verified === true`. Публічні ключі й їх кешування обробляє Google SDK. Довільний декодований JWT або email із клієнта не приймається.
- Стабільний ідентифікатор Google — `sub`, збережений у nullable `users.google_subject` з unique index. Повернення користувача визначається через `sub`; зміна email у Google не змінює і не об’єднує облікові записи Typstoria автоматично.
- За погодженням користувача новий Google-акаунт має `emailVerifiedAt` одразу; додаткового Mailjet-листа немає. Звичайна email/password реєстрація надалі потребує підтвердження листом.
- Новий Google-користувач має `password_hash = NULL`. Вигаданий пароль не створюється. Локальний login із будь-яким паролем повертає 401. Register з тим самим email не встановлює пароль і не змінює Google-зв’язок.
- Для Google-only користувача forgot-password повертає generic 202 без листа й без створення reset challenge: доступ відновлюється через Google. Це також не дозволяє сторонньому власнику старої зовнішньої email-адреси встановити локальний пароль. Для прив’язаного локального акаунта його власний пароль і Mailjet reset продовжують працювати.
- Збіг email з існуючим локальним акаунтом дає 409 `GOOGLE_ACCOUNT_LINK_REQUIRED`. Автоматичного прив’язування чи підтвердження локального акаунта через Google немає. Спочатку потрібно підтвердити локальну пошту та увійти звичайним способом; потім викликати `/auth/google/link` з власним Bearer і Google credential тієї самої адреси. Інший email або заміна вже прив’язаного Google subject дають 409 `GOOGLE_ACCOUNT_LINK_CONFLICT`.
- Unique constraints захищають від дублювання під час конкурентних входів. Прив’язування серіалізується блокуванням користувача. Перевірки `authVersion`, expiry та відкликання токена однакові для обох способів входу.
- Підтримується лише JSON callback flow. Cross-site HTML form POST відхиляється 415; чинні Origin/Fetch Metadata перевірки й точний CORS allowlist залишаються. Прямий GIS `login_uri` form POST із `g_csrf_token` не підтримується. Google-вхід не створює браузерних cookies й не передає токен у redirect URL.
- Без конфігурації — 503 `GOOGLE_AUTH_NOT_CONFIGURED`; невалідний/прострочений/чужий Google credential — 401 `GOOGLE_TOKEN_INVALID`. Provider error details, повний JWT і claims не потрапляють у логи та відповіді.

Міграція `AddGoogleSignIn1792494000000` додає Google subject і дозволяє NULL password hash, зберігаючи попередні облікові записи та паролі. Rollback блокується, якщо залишилися passwordless користувачі: їх не видаляють і не підміняють пароль випадковим значенням.

## Перевірки

Unit-тести перевіряють справжні RSA-підписи, audience, issuer, expiry, email verification та приховування provider errors. Замість Google public-key endpoint використовуються локальні тестові ключі. Integration-тести з PostgreSQL перевіряють реєстрацію/повторний Google-вхід, конкурентний вхід, прив’язування, колізії email, незмінність паролів, відсутність email-only recovery для Google-only, MIME/Origin та помилки конфігурації. Зовнішніх листів чи Google login-запитів тести не надсилають.

Джерела: [серверна перевірка Google ID token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [відображення кнопки](https://developers.google.com/identity/gsi/web/guides/display-button).

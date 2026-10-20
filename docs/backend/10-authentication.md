# Авторизація одним Bearer-токеном

Статус: 20.10.2026. Користувач обрав один Bearer access token без refresh-токенів, auth cookies та окремого CSRF-токена. Облікові записи й відкликання доступу працюють через PostgreSQL/TypeORM. OAuth/PAT для MCP, права на проєкти й фронтенд будуть окремими інкрементами; цей login не є OAuth provider.

## 1. Контракти

Префікс усіх маршрутів — `/api`. Точні DTO та відповіді генеруються з коду в `/docs` і `openapi.json`.

| Метод і маршрут                  | Тіло               | Результат                                                                                               |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`            | `{email,password}` | 202 generic message, лист підтвердження                                                                 |
| `POST /auth/login`               | `{email,password}` | 200 `{accessToken,tokenType,expiresAt,user}` після підтвердження пошти; інакше 403 `EMAIL_NOT_VERIFIED` |
| `GET /auth/me`                   | —                  | 200 user із `emailVerified`; потрібен Bearer                                                            |
| `POST /auth/logout`              | —                  | 204, відкликання поточного access token; потрібен Bearer                                                |
| `POST /auth/resend-verification` | `{email}`          | 202 generic message                                                                                     |
| `POST /auth/verify-email`        | `{token}`          | 200, підтвердження email та відкликання попередніх access tokens                                        |
| `POST /auth/forgot-password`     | `{email}`          | 202 generic message                                                                                     |
| `POST /auth/reset-password`      | `{token,password}` | 200, новий пароль та відкликання всіх access tokens                                                     |

Після register користувач має `emailVerifiedAt = null`; лист підтвердження надсилається автоматично через Mailjet, access token не видається. Login спочатку перевіряє пароль: неправильні credentials дають 401, правильний пароль без підтвердженої пошти — 403 `EMAIL_NOT_VERIFIED`, без створення сесії чи токена. Verify заповнює `emailVerifiedAt`, але не авторизує: після підтвердження потрібен окремий login. Усі приватні контролери, включно з me/logout, потребують чинного токена й підтвердженої пошти; старі токени непідтверджених облікових записів також не надають доступу. `@Public()` дозволяє анонімний запит без пошуку credentials у БД; `@VerifiedRequired()` перевизначає public policy контролера для приватних методів. `SessionGuard` заповнює `AuthRequest.identity` та `AuthRequest.actor` із БД. UserId/actor із body не є доказом доступу. Права на конкретний проєкт майбутній Access module перевірятиме додатково.

Email обрізається по краях, порівнюється в lowercase та має унікальний індекс у БД. Повторна реєстрація не змінює існуючий пароль. Новий пароль: 6–128 символів без вимог до великих літер, цифр чи спецсимволів та без прихованого trim/нормалізації. Правило однакове для register і reset. Невідомий email і неправильний пароль дають однакову 401 `INVALID_CREDENTIALS`. Register/resend/forgot не повідомляють, чи існує обліковий запис.

Google Identity Services — окремий спосіб входу: [11-google-sign-in.md](11-google-sign-in.md). Для нової Google-реєстрації погоджено приймати підтверджену Google пошту без Mailjet-листа; локальна реєстрація працює за правилами вище. Google-only користувачі не мають локального пароля і відновлюють доступ через Google; forgot-password не створює їм локальний пароль.

## 2. Swagger і фронтенд

1. Виконати register, отримати автоматичний лист і підтвердити адресу через `POST /api/auth/verify-email`. Потім виконати `POST /api/auth/login` з email і паролем. Login до підтвердження повертає 403 `EMAIL_NOT_VERIFIED`. Для register/login/verify/reset не потрібні заголовки авторизації.
2. Скопіювати `accessToken` із відповіді в **Authorize → bearer**. Вставляється лише токен, без префікса `Bearer`.
3. Swagger надсилатиме приватні запити з `Authorization: Bearer <accessToken>`. Фронтенд має додавати той самий заголовок у своєму HTTP-клієнті.
4. Після logout видалити токен на клієнті. Після закінчення строку дії, відкликання або скидання пароля приватні запити повернуть 401 — потрібно увійти повторно. Автоматичного refresh немає.

Клієнт отримує access token лише у відповіді login. У пам'яті фронтенду його можна зберігати без запису в browser storage; тоді після повного перезавантаження сторінки потрібен повторний вхід. Постійне зберігання через localStorage не реалізоване й не додається автоматично. Swagger не зберігає авторизацію між перезавантаженнями (`persistAuthorization=false`).

Bearer використовує стандартний [Authorization header](https://www.rfc-editor.org/rfc/rfc6750#section-2.1), без приймання credentials з cookie, query string або request body. Пароль — Argon2id, 64 MiB, 3 проходи, parallelism 1. Access token — `sessionId.secret` із числовим `sessionId`, де secret містить 32 випадкові байти; БД зберігає лише SHA-256 секрету. Це непрозорий токен, не JWT; signing secret не потрібний. Відкликання, authVersion та expiry перевіряються в БД на кожний приватний запит. Login та відповіді з профілем мають `Cache-Control: no-store`, `Pragma: no-cache`.

`web_sessions` залишається таблицею активних входів: кожний login створює окремий access token. Окремих `/sessions` маршрутів у API та Swagger немає; `/auth/logout` відкликає тільки поточний токен, а підтвердження пошти / reset — усі попередні токени користувача. Додаткова міграція при переході з cookie на Bearer не потрібна: структура записів та правила revoke залишилися тими самими. Старі auth cookies ігноруються і не надають доступу.

`/auth/csrf` видалений; CSRF-cookie, anonymous cookie і `X-CSRF-TOKEN` не використовуються. Браузер не додає Authorization самостійно. Додаткова перевірка Origin/Fetch Metadata для небезпечних браузерних запитів залишена через Nest `enableCsrfProtection`, без токенів. CORS має точний список дозволених frontend origins і не вмикає credentials cookies. З фронтенду не потрібно `credentials: 'include'`; потрібен явний Authorization header.

ID користувача, сесії та email challenge — додатні автоінкрементні `integer`, в JSON передаються числами. Публічна частина Bearer-токена приймає лише канонічний десятковий ID 1–2147483647. Значення 0, від'ємні, дробові, UUID та значення поза діапазоном відхиляються до SQL. Secret у Bearer-токені залишається криптографічно випадковим: послідовний ID не надає права доступу. RequestId у помилках — окремий рядковий ідентифікатор трасування.

Міграція `UseNumericIdentityIds1792330200000` переносить наявні users/sessions/challenges через тимчасові колонки, зберігаючи дані та FK ownership. Вона відкликає старі сесії через зміну їхніх ID: після застосування потрібно увійти заново. Email-посилання залишаються чинними до свого expiry, оскільки їхній випадковий tokenHash не змінюється. Попередні міграції не переписуються. `down` повертає UUID-схему зі збереженням записів і зв'язків, але генерує нові UUID; для повернення точних попередніх ID потрібна резервна копія.

Поле `status` і блокування користувачів вилучено. Міграція `RemoveUserStatus1792488600000` видаляє колонку та enum `user_status`, зберігаючи облікові записи, паролі й токени. Rollback повертає колонку з `active` для всіх; колишні значення статусу можна відновити лише з backup. `authVersion` залишається внутрішнім лічильником відкликання доступу й не потрапляє у відповіді API.

## 3. Mailjet

Використовується [Mailjet Send API v3.1](https://dev.mailjet.com/docs/email-api/send-api-v31/send-basic-email), HTTPS POST на фіксований `https://api.mailjet.com/v3.1/send`, Basic auth із public/secret API keys. Відправник має бути підтверджений у Mailjet. Підтвердження пошти та відновлення пароля використовують спільний адаптивний HTML-шаблон Typstoria з окремими заголовками, кнопками дії та поясненнями. Є рівнозначна plain-text версія, запасне посилання і зрозумілий фактичний строк дії: за замовчуванням 24 години / 15 хвилин. HTML не використовує зовнішні зображення, скрипти або шрифти; динамічні посилання екрануються, click/open tracking вимкнений для посилань безпеки. Timeout запиту — 10 секунд; перевіряються HTTP status та `Messages[0].Status`, оскільки HTTP 200 сам по собі не підтверджує прийняття листа.

```dotenv
MAIL_FROM=no-reply@your-verified-domain.example
MAILJET_API_KEY=replace-with-public-key
MAILJET_SECRET_KEY=replace-with-secret-key
PUBLIC_WEB_URL=https://app.your-domain.example
```

Ключі вводяться в локальний `.env` або secret store сервера. `.env` не потрапляє до Git. Без ключів та підтвердженого відправника реальне надсилання не перевірене; автоматичні тести підміняють HTTP Mailjet і не надсилають листів.

Mailjet — єдиний поштовий adapter у development і production. `MAIL_FROM`, `MAILJET_API_KEY`, `MAILJET_SECRET_KEY` обов’язкові для старту API; локального mailbox, запису листів на диск чи альтернативного transport немає. Для перевірки через Swagger зареєструй доступну тобі адресу, отримай справжній лист і передай токен після `#token=` у відповідний POST. Автоматичні тести підміняють mailer або HTTP запит лише в тестовому процесі.

Посилання в листах ведуть на `${PUBLIC_WEB_URL}/auth/verify-email#token=...` та `/auth/reset-password#token=...`. Frontend повинен прочитати fragment, прибрати його з адресного рядка та виконати відповідний POST після дії користувача. GET посилання не споживає токен: поштові сканери не повинні підтверджувати email автоматично. Ці frontend сторінки ще не реалізовані в backend-репозиторії.

Токен — 32 криптографічно випадкові байти; БД зберігає SHA-256. Термін дії: verify 24 години, reset 15 хвилин. Reset не підтверджує пошту і не авторизує: непідтверджений обліковий запис після зміни пароля все одно має пройти verify. Використаний/прострочений/чужого призначення токен дає 400 `INVALID_OR_EXPIRED_TOKEN`. Повторне надсилання має cooldown 5 хвилин (300 секунд) на user + вид токена, спільний для register/resend і окремий для reset; нове посилання скасовує старі цього виду. Успішне споживання серіалізується блокуванням user row: лише один паралельний запит може прийняти токен. Password reset і створення сесії використовують те саме блокування та authVersion, щоб вхід зі старим паролем не створив чинну сесію після reset.

Надсилання відбувається після commit транзакції БД. Якщо Mailjet недоступний, API повертає ту саму generic 202. Журнал містить тип події, безпечну категорію помилки (`authentication_failed`, `request_rejected`, `message_rejected`, `transport_error`) і HTTP status, якщо отримано відповідь із відмовою; email, токен, provider payload і ключі не записуються. `authentication_failed` / HTTP 401 означає, що Mailjet не прийняв пару API Key / Secret Key: перевірити обидва значення з одного API key у Mailjet → Account settings → API Key Management, оновити `.env` і перезапустити API. Самої зміни `.env` для запущеного процесу недостатньо. `202 Accepted` підтверджує обробку запиту, а не доставку листа. Користувач може повторити запит через 5 хвилин після останнього створеного листа цього виду; запити протягом cooldown не подовжують його і не скасовують чинне посилання. Durable mail outbox, автоматичних retries та delivery webhooks наразі немає; прийняття Mailjet не гарантує потрапляння у вхідні. Це наступне операційне поліпшення, якщо знадобиться гарантоване повторне надсилання після збою процесу.

## 4. Конфігурація production

Обов'язкові: `NODE_ENV=production`, власний `DATABASE_URL`, `PUBLIC_WEB_URL=https://...`, точний `CORS_ORIGINS`, `MAIL_FROM`, `MAILJET_API_KEY`, `MAILJET_SECRET_KEY`. API має бути доступний через HTTPS, оскільки Bearer-токен надає доступ тому, хто ним володіє.

`AUTH_ACCESS_TOKEN_TTL_SECONDS` задає фіксований строк дії access token (за замовчуванням 604800 секунд, 7 днів). `AUTH_VERIFY_TTL_SECONDS` і `AUTH_RESET_TTL_SECONDS` задають TTL одноразових email-токенів. `AUTH_SESSION_TTL_SECONDS` замінено на `AUTH_ACCESS_TOKEN_TTL_SECONDS`; `AUTH_CSRF_SECRET` більше не потрібний. Swagger за замовчуванням вимкнений у production. Offline OpenAPI export не потребує mail secrets і не запускає надсилання листів.

Throttler обмежує login до 10 запитів/хв на IP, register/resend/forgot/reset — до 5, решту маршрутів — 120; health checks виключені. Поточний storage у пам'яті одного API-процесу, reset при restart. Для кількох replicas потрібен shared storage або узгоджені gateway limits. Proxy headers автоматично не довірені; перед production reverse proxy необхідно налаштувати обмежену довіру лише до його адрес, щоб IP rate limit відрізняв клієнтів і не довіряв підробленому X-Forwarded-For. Прострочені сесії/challenges відхиляються незалежно від наявності фізичного запису; окремий retention cleanup job ще не доданий.

## 5. Перевірки

```bash
npm run db:up
npm run migration:run
npm run check
npm run test:integration
```

Тести з PostgreSQL перевіряють register/login без попередніх запитів за CSRF, відсутність Set-Cookie/refreshToken, автоматичний лист після register, відмову видавати токен до verify, заборону приватного доступу зі старим непідтвердженим токеном, відсутність автоматичного входу після verify/reset, незалежний cooldown 5 хвилин на листи обох видів і конкурентне повторне надсилання, видачу й expiry Bearer-токена, відмову приймати credentials через cookies/query/body, malformed/duplicate Authorization headers, Origin/CORS, DTO validation, email normalization/duplicates, одноразовість verify/reset, конкурентне споживання, відкликання всіх access tokens після reset, гонку зі старим login snapshot, ізоляцію токенів між користувачами, logout, відсутність маршрутів керування сесіями та rate limits. Mailjet transport тестується через підміну fetch. Integration suite видаляє тільки власні унікальні тестові accounts; пов'язані sessions/challenges видаляє FK CASCADE.

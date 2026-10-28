# Typstoria — серверна частина

Реалізовано початковий каркас **NestJS + TypeORM + PostgreSQL**: модулі предметних областей, конфігурацію, міграції, health endpoints, Swagger/OpenAPI, обробку помилок, request ID, тести та CI. Реалізовано також реєстрацію, вхід/вихід, один Bearer access token без refresh/cookies, підтвердження пошти й відновлення пароля через Mailjet та rate limits. Перший сценарій P2 створює приватний проєкт із порожнім `main.typ` і ревізією №1 та дозволяє прочитати його стан, переглянути список власних проєктів, перейменувати або м’яко видалити проєкт. Працює також атомарне редагування текстових файлів і контексту з новою ревізією. Працюють staging uploads ресурсів, їх атомарне додавання/заміна та скачування з поточної або історичної ревізії. Асинхронна компіляція прийнятої ревізії в PDF через окремий worker і Linux sandbox також працює. Git writer, історія/diff ревізій та restore також працюють. MCP і review ще не реалізовані. Документація розрізняє реалізовані сценарії та цільову систему.

## Локальний запуск

Потрібні Node.js **24.15+ у гілці 24 LTS**, npm і Docker Compose v2. Файл `.nvmrc` задає Node 24. **У контейнері працює тільки PostgreSQL. API запускається локально.**

```bash
nvm install
nvm use
cp .env.example .env
# Заповни MAIL_FROM, MAILJET_API_KEY та MAILJET_SECRET_KEY у .env.
npm ci
npm run db:up
npm run migration:run
npm run start:dev
```

Якщо `.env` уже існує, збережи його налаштування замість повторного копіювання. Якщо використовуєш інший менеджер Node.js, вибери ту саму версію без команд `nvm`.

- Swagger UI: [http://127.0.0.1:3000/docs](http://127.0.0.1:3000/docs).
- OpenAPI JSON: [http://127.0.0.1:3000/docs-json](http://127.0.0.1:3000/docs-json).
- Liveness: [http://127.0.0.1:3000/health/live](http://127.0.0.1:3000/health/live).
- Readiness з перевіркою БД: [http://127.0.0.1:3000/health/ready](http://127.0.0.1:3000/health/ready).

API має префікс `/api`; health і документація доступні без нього. Swagger показує лише фактично реалізовані endpoints. `SWAGGER_ENABLED=false` вимикає UI та JSON; без явного налаштування вони вимкнені у production.

## Авторизація та Mailjet

`/api/auth`: `register`, `login`, `me`, `logout`, `resend-verification`, `verify-email`, `forgot-password`, `reset-password`. Керування сесіями через окремі API-маршрути відсутнє. Приватні маршрути за замовчуванням потребують підтвердженої пошти.

Пошта надсилається виключно через Mailjet, зокрема під час локальної розробки. Перед запуском заповни `MAIL_FROM`, `MAILJET_API_KEY`, `MAILJET_SECRET_KEY` у `.env`; відправник має бути підтверджений у Mailjet. `PUBLIC_WEB_URL` — адреса фронтенду для посилань. Без цих трьох налаштувань API не стартує. Листи на диск не записуються; додаткових контейнерів немає.

Після реєстрації автоматично надсилається лист підтвердження. До підтвердження login повертає 403 `EMAIL_NOT_VERIFIED` без токена; приватні функції недоступні. Повторний лист — раз на 5 хвилин. Підтвердження пошти та reset самі по собі не авторизують.

У Swagger після підтвердження пошти виконай `POST /api/auth/login`, скопіюй `accessToken` із відповіді в **Authorize → bearer** (без слова `Bearer`). Приватні запити надсилатимуть `Authorization: Bearer <accessToken>`. Cookies, окремого CSRF-токена та refresh-токена немає. Строк дії задається `AUTH_ACCESS_TOKEN_TTL_SECONDS` (типово 7 днів); після закінчення потрібен новий вхід. Logout відкликає токен у БД. Деталі — у [10-authentication.md](docs/backend/10-authentication.md).

## Вхід через Google

`POST /api/auth/google` приймає JSON `{idToken}` від Google Identity Services і повертає звичайний токен Typstoria. Новий Google-користувач має підтверджену пошту без додаткового листа. Для наявного локального акаунта передбачене явне прив’язування через `POST /api/auth/google/link` після звичайного входу. Google-only акаунти не мають локального пароля; відновлення доступу відбувається через Google.

Потрібен `GOOGLE_CLIENT_ID` типу Web application; Client Secret не використовується. Без Client ID Google-вхід вимкнений, решта API працює. Налаштування Google Cloud та контракт фронтенду: [11-google-sign-in.md](docs/backend/11-google-sign-in.md).

## Створення проєкту

`POST /api/projects` приймає `{ "title": "Дипломна робота" }` і обов'язковий заголовок `Idempotency-Key`. Потрібен Bearer-токен підтвердженого користувача. Сервер атомарно створює проєкт, `main.typ`, знімок, ревізію №1, audit і pending Git mapping. Повтор із тим самим ключем у цій сесії повертає ті самі ID; інша назва — 409.

Прочитати результат можна через `GET /api/projects/:id`, `/state` та `/files/:fileId?revisionId=…`. `GET /api/projects` повертає власні активні проєкти з cursor-пагінацією (типово 20, максимум 100, порядок `id DESC`). `PATCH /api/projects/:id` приймає `{ "title": "Нова назва" }`; останнє завершене перейменування перемагає та змінює лише метадані. `DELETE /api/projects/:id` повертає 204 і закриває доступ через `deletedAt`; фізичне очищення виконується пізніше.

Байти зберігаються приватно на host у `BLOB_STORAGE_PATH` (типово `.local/blobs`); каталог не обслуговується через static HTTP. Git-проєкція асинхронна; її поточний статус доступний у revision history та `/state`. Контракти й інструкція перевірки — у [12-project-creation.md](docs/backend/12-project-creation.md).

## Атомарне збереження тексту

`POST /api/projects/:id/changes` приймає `baseRevisionId`, необов'язковий `summary` та масив типізованих операцій: `createFile`, `updateText`, `renameFile`, `deleteFile`, `setEntrypoint`, `updateContext`, `attachFile`, `replaceFile`. Обов'язковий `Idempotency-Key`. Зміни створюють одну ревізію або повністю відхиляються; save без зміни стану повертає поточну ревізію; stale base дає 409 `REVISION_CONFLICT`. Повтор успішного запиту повертає записану відповідь. `GET /api/projects/:id/state?revisionId=…` і читання файла дозволяють переглянути попередній стан.

Міграція узагальнює `project_creations` до `idempotency_records` зі збереженням наявних create keys. Приклади, ліміти й семантика операцій — у [13-atomic-text-changes.md](docs/backend/13-atomic-text-changes.md).

## Ресурси документа

`POST /api/projects/:id/uploads` приймає один multipart `file` до 10 MiB без обов’язкового `Idempotency-Key`. Підтримуються PNG/JPEG/GIF/WebP/PDF та TTF/OTF/WOFF/WOFF2. Upload не змінює ревізію: використай отриманий `uploadId` в `attachFile` або `replaceFile` через `/changes`. Статус доступний через `GET /uploads/:uploadId`, скачування прикріпленого файла — через `GET /files/:fileId/download?revisionId=…` із Bearer-токеном.

References доступні для повторного використання 24 години; до 400 unexpired uploads/256 MiB на owner, включно з прикріпленими; автоматичне очищення диска ще не реалізоване. Контракт і приклади — у [14-resource-uploads.md](docs/backend/14-resource-uploads.md).

## Компіляція в PDF

`POST /api/projects/:id/compilations` із `{ "revisionId": 1 }` без `Idempotency-Key` повертає 202 і job ID. `GET /compilations/:jobId` показує статус, diagnostics, `isCurrent` та `artifactAvailable`; `/compilations/:jobId/pdf` приватно віддає результат успішної задачі. Source не змінюється; старий PDF залишається прив'язаним до своєї ревізії.

Потрібен окремий `npm run worker:compile:dev` (після build — `npm run worker:compile`). Задачі зберігаються в PostgreSQL і чекають worker при його недоступності. Локальний runner використовує Typst 0.14.2, Bubblewrap і systemd user cgroups; Docker залишається лише для БД. Задай `TYPST_BINARY_PATH` у `.env`. Зовнішні пакети `@preview/...` зараз недоступні; fonts із проєкту та embedded fonts підтримуються. Контракт, обмеження й перевірки — у [15-compilation.md](docs/backend/15-compilation.md).

## Історія та відновлення

`GET /api/projects/:id/revisions` повертає прийняті ревізії з cursor-пагінацією та Git status; `/revisions/:revisionId/diff?against=…` порівнює immutable snapshots за сталими file IDs. Text patches обмежені, binary має metadata/hashes. `POST /restore` з `targetRevisionId`, `expectedCurrentRevisionId` та `Idempotency-Key` створює нову ревізію з попереднім станом.

Окремий `npm run worker:history:dev` (після build — `npm run worker:history`) обробляє pending mappings безпосередньо з PostgreSQL і пише приватні bare repos у `GIT_STORAGE_PATH` (типово `.local/history`). Git outage не скасовує saves; history/diff/restore читають PostgreSQL. Повтори writer відновлюють той самий commit SHA. Контракт, retry та перевірки — у [16-git-history.md](docs/backend/16-git-history.md).

## Автоматична специфікація Swagger

Специфікація генерується з контролерів, TypeScript DTO, JSDoc-коментарів і декораторів `class-validator` через `@nestjs/swagger` compiler plugin у `nest-cli.json`.

- `npm run build` автоматично створює `openapi.json` у корені через `postbuild`. Експорт працює без підключення до PostgreSQL та без запуску HTTP-сервера: Nest preview mode читає метадані програми, не створюючи providers.
- Під час `npm run start:dev` після зміни коду сервер перезапускається, а `/docs` і `/docs-json` відображають актуальну специфікацію. Файл на диску оновлюється під час build.
- `npm run openapi:export` явно запускає ту саму збірку з експортом; окрему специфікацію вручну підтримувати не потрібно.
- CI збирає та публікує `openapi.json` як artifact. Файл залишається у `.gitignore`.

DTO мають бути класами у файлах `*.dto.ts`, методи контролерів — мати явний тип відповіді. Plugin визначає поля, required/optional, масиви, вкладені DTO та доступні обмеження валідаторів. `@ApiProperty` потрібний лише для уточнень, які не випливають із типу, наприклад date-time format; додаткові коди помилок і security описуються окремими Swagger-декораторами. Entities автоматично не документуються. Runtime-валідація і надалі потребує `class-validator`.

## Команди

| Команда                                            | Призначення                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `npm run start:dev`                                | Локальний API з перезапуском після змін                           |
| `npm run build` / `npm run start:prod`             | Збірка / запуск скомпільованого API                               |
| `npm run db:up` / `npm run db:stop`                | Підняти БД із healthcheck / зупинити                              |
| `npm run db:down`                                  | Прибрати Compose container/network зі збереженням volume          |
| `npm run db:logs`                                  | Журнал PostgreSQL                                                 |
| `npm run migration:run` / `npm run migration:show` | Застосувати / переглянути міграції                                |
| `npm run migration:run:prod`                       | Міграції зі скомпільованої збірки                                 |
| `npm run check`                                    | Форматування, lint, typecheck, unit/HTTP tests, build             |
| `npm run test:integration`                         | Реальні PostgreSQL-тести; потрібна БД із застосованими міграціями |
| `npm run openapi:export`                           | Зібрати код і записати `openapi.json` без підключення до БД       |

### Міграції TypeORM

`synchronize` і автоматичний запуск міграцій вимкнені в усіх середовищах. Міграції створюють `users`, `web_sessions` та `identity_challenges` із числовими автоінкрементними ID. Наявні UUID-записи переносяться окремою міграцією зі збереженням зв’язків; старі сесії відкликаються, потрібен повторний вхід. Звичайні читання виключають password/token/secret hashes.

```bash
# Після зміни entities: перевір SQL перед застосуванням.
npm run migration:generate -- src/infrastructure/database/migrations/AddProjects
npm run migration:run

# Порожня міграція для ручного SQL.
npm run migration:create -- src/infrastructure/database/migrations/CustomChange

# Відкотити останню міграцію, якщо це потрібно і безпечно для даних.
npm run migration:revert
```

API і CLI використовують спільні database options. `null`/`undefined` у where conditions заборонені, щоб відсутній ідентифікатор не перетворювався на необмежений запит.

### Конфігурація

`.env.example` містить локальні значення. `DATABASE_URL` має відповідати `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` і `POSTGRES_PORT` у Compose. Якщо 5432 зайнятий, зміни `POSTGRES_PORT` і порт у `DATABASE_URL`. PostgreSQL прив'язаний лише до `127.0.0.1`, дані зберігаються в named volume.

Змінні оточення перевіряються до старту: порт, PostgreSQL URL, явні boolean, точні CORS origins, pool/timeouts. Production потребує власних credentials; локальні приклади для нього не підходять. Зміна `POSTGRES_*` після першого створення volume не змінює вже наявного користувача/пароля в PostgreSQL — використовуй SQL-міграцію налаштувань або нову локальну БД, зберігши потрібні дані.

Redis, S3, Typst і Tinymist не є залежностями старту API. Для compile worker потрібні PostgreSQL і sandboxed Typst на host; Redis не використовується. Для source blobs уже працює приватний локальний storage. Решта adapters і workers додаються у відповідних інкрементах. Локальна вимога зберігається: за потреби вони запускаються на host, а не додаються до Compose.

## Структура

```text
src/
  bootstrap/                 # HTTP setup та Swagger
  config/                    # typed config і перевірка environment
  common/{actor,errors,http}/
  infrastructure/database/   # TypeORM options, CLI DataSource, migrations
  infrastructure/mail/       # Mailjet Send API
  modules/
    health/                  # реалізований HTTP/application flow
    identity/                # Bearer auth, sessions, verify/reset workflows
    projects/                # CRUD with soft delete, initial revision, ownership/idempotency
    files/ revisions/        # private local blobs, stable IDs, immutable snapshots
    access/ history/
    compilation/ proposals/ context/ annotations/
    templates/ editor/ transfer/ backup/ mcp/ jobs/ audit/
  cli/                       # OpenAPI export
test/                        # HTTP tests та окремі DB integration tests
compose.yaml                 # лише PostgreSQL
.github/workflows/ci.yml
```

Доменні модулі поки задають межі залежностей. Підкаталоги `http/application/domain/infrastructure` додаються разом із реальною логікою; фіктивних CRUD endpoint немає. [Інструкція розвитку каркаса](docs/backend/09-development.md) описує правила entities, міграцій, модулів і перевірок.

Погоджено з користувачем: **TypeScript + NestJS**, серверне розгортання через інтернет, обов'язковий функціонал обох етапів вихідного бачення, універсальний MCP, підтвердження всіх ШІ-правок користувачем, резервне копіювання в GitHub лише назовні. Некомпільовану ШІ-пропозицію можна прийняти після явного попередження.

## Документація

| Файл                                                                          | Що містить                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [01-scope.md](docs/backend/01-scope.md)                                       | Межі продукту, вимоги, критерії завершеності                    |
| [02-architecture.md](docs/backend/02-architecture.md)                         | Стек, модулі NestJS, взаємодія компонентів                      |
| [03-data-model.md](docs/backend/03-data-model.md)                             | Сутності, версії, файли, Git, цілісність даних                  |
| [04-workflows.md](docs/backend/04-workflows.md)                               | Збереження, компіляція, ШІ-пропозиції, відновлення, шаблони     |
| [05-api-and-mcp.md](docs/backend/05-api-and-mcp.md)                           | Контракти REST, MCP, OAuth та повідомлень для фронтенду         |
| [06-security-and-operations.md](docs/backend/06-security-and-operations.md)   | Ізоляція компіляції, безпека, запуск, резервні копії            |
| [07-delivery-plan.md](docs/backend/07-delivery-plan.md)                       | Послідовність робіт, залежності, перевірки, критерії приймання  |
| [08-decisions-and-references.md](docs/backend/08-decisions-and-references.md) | Рішення, відкриті питання, аналіз SmartTeX, офіційні джерела    |
| [10-authentication.md](docs/backend/10-authentication.md)                     | Реалізована авторизація, Mailjet, Bearer flow, обмеження        |
| [09-development.md](docs/backend/09-development.md)                           | Реалізований каркас, локальний запуск і правила розвитку        |
| [12-project-creation.md](docs/backend/12-project-creation.md)                 | CRUD проєктів, початкова ревізія, storage та idempotency        |
| [13-atomic-text-changes.md](docs/backend/13-atomic-text-changes.md)           | Атомарні текстові saves, конфлікти, квоти й історичне читання   |
| [14-resource-uploads.md](docs/backend/14-resource-uploads.md)                 | Staging ресурсів, attach/replace, приватне історичне скачування |
| [15-compilation.md](docs/backend/15-compilation.md)                           | PostgreSQL jobs, Linux sandbox, diagnostics та PDF              |
| [16-git-history.md](docs/backend/16-git-history.md)                           | Приватна Git-проєкція, revisions/diff, restore, retry/recovery  |

Рекомендований порядок читання: 01 → 02 → 04 → 07, потім деталізація моделі та API. Реєстр у файлі 08 відокремлює погоджені рішення від запропонованих технічних деталей.

## Вихідні матеріали

- [Бачення проєкту Диплом.txt](Бачення%20проєкту%20Диплом.txt).
- [Аналіз аналогів програмної системи.txt](Аналіз%20аналогів%20програмної%20системи.txt).
- [ФОРМУВАННЯ ВИМОГ ДО ПРОГРАМНОЇ СИСТЕМИ.txt](ФОРМУВАННЯ%20ВИМОГ%20ДО%20ПРОГРАМНОЇ%20СИСТЕМИ.txt).
- Прототип для дослідження: `/home/yehor/Downloads/SmartTeX-master/`.

Вихідні документи використано як предметні матеріали. Їхні згадки про «мінімум», «перспективу» й можливі реалізації не замінюють подальших відповідей користувача. Після уточнення обидва етапи включено до обов'язкової поставки. Код SmartTeX не переносився.

Оновлення схеми й контрактів: [17-simplification.md](docs/backend/17-simplification.md).

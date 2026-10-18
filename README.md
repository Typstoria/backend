# Typstoria — серверна частина

Реалізовано початковий каркас **NestJS + TypeORM + PostgreSQL**: модулі предметних областей, конфігурацію, міграції, health endpoints, Swagger/OpenAPI, обробку помилок, request ID, тести та CI. Бізнес-сценарії авторизації, документів, MCP, компіляції та review ще не реалізовані. Документація нижче описує цільову систему.

## Локальний запуск

Потрібні Node.js **24.15+ у гілці 24 LTS**, npm і Docker Compose v2. Файл `.nvmrc` задає Node 24. **У контейнері працює тільки PostgreSQL. API запускається локально.**

```bash
nvm install
nvm use
cp .env.example .env
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

API має префікс `/api/v1`; health і документація доступні без нього. Swagger показує лише фактично реалізовані endpoints. `SWAGGER_ENABLED=false` вимикає UI та JSON; без явного налаштування вони вимкнені у production.

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

`synchronize` і автоматичний запуск міграцій вимкнені в усіх середовищах. Початкова міграція створює таблицю `users`; наявність entity не означає готового auth API. Звичайні читання entity виключають `passwordHash`.

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

Redis, S3, SMTP, Typst і Tinymist не є залежностями поточного старту. Їхні adapters і workers додаються у відповідних інкрементах. Локальна вимога зберігається: за потреби вони запускаються на host, а не додаються до Compose.

## Структура

```text
src/
  bootstrap/                 # HTTP setup та Swagger
  config/                    # typed config і перевірка environment
  common/{actor,errors,http}/
  infrastructure/database/   # TypeORM options, CLI DataSource, migrations
  modules/
    health/                  # реалізований HTTP/application flow
    identity/                # User entity та repository registration
    access/ projects/ files/ revisions/ history/
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

| Файл                                                                          | Що містить                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [01-scope.md](docs/backend/01-scope.md)                                       | Межі продукту, вимоги, критерії завершеності                   |
| [02-architecture.md](docs/backend/02-architecture.md)                         | Стек, модулі NestJS, взаємодія компонентів                     |
| [03-data-model.md](docs/backend/03-data-model.md)                             | Сутності, версії, файли, Git, цілісність даних                 |
| [04-workflows.md](docs/backend/04-workflows.md)                               | Збереження, компіляція, ШІ-пропозиції, відновлення, шаблони    |
| [05-api-and-mcp.md](docs/backend/05-api-and-mcp.md)                           | Контракти REST, MCP, OAuth та повідомлень для фронтенду        |
| [06-security-and-operations.md](docs/backend/06-security-and-operations.md)   | Ізоляція компіляції, безпека, запуск, резервні копії           |
| [07-delivery-plan.md](docs/backend/07-delivery-plan.md)                       | Послідовність робіт, залежності, перевірки, критерії приймання |
| [08-decisions-and-references.md](docs/backend/08-decisions-and-references.md) | Рішення, відкриті питання, аналіз SmartTeX, офіційні джерела   |
| [09-development.md](docs/backend/09-development.md)                           | Реалізований каркас, локальний запуск і правила розвитку       |

Рекомендований порядок читання: 01 → 02 → 04 → 07, потім деталізація моделі та API. Реєстр у файлі 08 відокремлює погоджені рішення від запропонованих технічних деталей.

## Вихідні матеріали

- [Бачення проєкту Диплом.txt](Бачення%20проєкту%20Диплом.txt).
- [Аналіз аналогів програмної системи.txt](Аналіз%20аналогів%20програмної%20системи.txt).
- [ФОРМУВАННЯ ВИМОГ ДО ПРОГРАМНОЇ СИСТЕМИ.txt](ФОРМУВАННЯ%20ВИМОГ%20ДО%20ПРОГРАМНОЇ%20СИСТЕМИ.txt).
- Прототип для дослідження: `/home/yehor/Downloads/SmartTeX-master/`.

Вихідні документи використано як предметні матеріали. Їхні згадки про «мінімум», «перспективу» й можливі реалізації не замінюють подальших відповідей користувача. Після уточнення обидва етапи включено до обов'язкової поставки. Код SmartTeX не переносився.

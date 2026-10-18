# Розвиток початкового каркаса

Статус: реалізований foundation, 18.10.2026. Це частина P1, а не готовий функціонал P1–P9.

## 1. Що працює

- NestJS application graph із модулями цільових предметних областей.
- Typed environment validation, PostgreSQL через TypeORM, CLI DataSource та початкова User migration.
- `/health/live`, `/health/ready`, Swagger UI `/docs`, OpenAPI `/docs-json`.
- Global validation, CORS allowlist, Helmet, request ID, JSON logs, error envelope.
- Unit/HTTP tests, окремий PostgreSQL integration suite, lint/typecheck/build і GitHub Actions.

Реєстрації/входу, project CRUD, MCP transport, OAuth, runner, Git, queue та storage adapters ще немає. Порожні модулі не вважаються реалізацією відповідних вимог.

## 2. Середовище

Єдиний Compose service — `db`. API запускається через npm на host. Поточний старт не потребує Redis, S3 або SMTP. Майбутній локальний режим цих компонентів також має виконувати правило користувача: Docker використовується лише для БД.

Node 24.15+ потрібний у тому числі інструментам Nest CLI; `npm ci` відтворює lockfile. `.env` не комітиться. Початкові DB credentials у `.env.example` призначені тільки для development.

## 3. Додавання модуля або use case

1. HTTP controller і DTO розміщуються у `modules/<name>/http`.
2. Use case/service — у `application`; правила станів/actor — у `domain`, коли з'явиться реальна потреба.
3. TypeORM entities та adapters — у `infrastructure/persistence` конкретного модуля.
4. Нові entities явно додати до `createDatabaseOptions`, а repositories зареєструвати через `TypeOrmModule.forFeature` у модулі-власнику. Спільний список entities використовує також CLI міграцій.
5. Для REST використати класи `*.dto.ts`, явні return types контролерів та JSDoc-коментарі. Swagger compiler plugin автоматично додає базові schema/response metadata; додаткові error codes, security і специфічні формати описуються декораторами. Не повертати TypeORM entity напряму: доменні password/credential fields не мають стати частиною API.
6. Application service приймає перевіреного actor. MCP adapter у майбутньому викликає ту саму логіку, але policy забороняє йому direct write/accept.

Не використовувати TypeORM global repository/manager усередині transaction callback: всі пов'язані записи виконуються через переданий transactional manager/query runner. Optimistic concurrency для project revisions реалізувати умовним update/row lock у тій самій транзакції, а не лише decorator `VersionColumn`.

## 4. Схема та міграції

`synchronize=false`, `migrationsRun=false`, `dropSchema=false` зафіксовані в коді. `migration:generate` вимагає застосованих попередніх міграцій і доступної БД; згенерований SQL перевіряється вручну. Міграції комітяться разом з entities. Production runner використовує `dist/.../data-source.js` після build.

Первинний UUID генерує PostgreSQL через вбудований `gen_random_uuid()`, без встановлення extensions від імені API. Дати — `timestamptz`; email uniqueness задає DB index по normalizedEmail. Нормалізацію email та password hashing потрібно реалізувати в Identity use cases, перш ніж відкривати auth endpoints.

Readiness виконує `SELECT 1`, а не підтверджує готовність ще не реалізованих інтеграцій. TypeORM встановлює initial connection під час startup; якщо БД недоступна від самого початку, API завершує старт з помилкою. Після успішного старту liveness не звертається до БД, readiness повертає 503 при втраті підключення.

## 5. Перевірки

`npm run check` не потребує running DB: HTTP tests замінюють тільки DataSource, але перевіряють справжній Nest HTTP pipeline, Swagger, DTO validation, body limits і errors. Jest запускається з `--experimental-vm-modules` для ESM-залежностей NestJS 12; npm scripts уже містять потрібний прапорець. `npm run test:integration` використовує реальний application graph та PostgreSQL, перевіряє міграції, запис/читання User, uniqueness і виключення passwordHash.

Integration suite створює унікальний тестовий запис і видаляє тільки його; не очищає всі таблиці. Для регулярної розробки рекомендована окрема test database із власним DATABASE_URL; у CI вона окрема. Credentials не треба вставляти в командах, які потраплять до shared logs.

Перед merge: `npm ci`, `npm run check`, `npm run migration:run`, `npm run test:integration`. `check` виконує build, а postbuild автоматично записує `openapi.json` без доступу до БД. Окрема команда `npm run openapi:export` запускає ту саму збірку для ручного експорту. Усі компоненти CI, крім PostgreSQL service, запускаються без контейнерів.

## 6. Code-first OpenAPI

Налаштування compiler plugin живуть у `nest-cli.json`: лише `*.dto.ts`, `classValidatorShim`, `introspectComments`. Jest використовує ті самі options через `test/swagger-transformer.cjs`, щоб тести бачили ті самі схеми, що й реальна збірка. Типи entities не переносяться автоматично до API.

`createOpenApiDocument` є спільним для Swagger UI, `/docs-json` і файлового експорту. Глобальний API prefix та health exclusions теж задаються однією функцією `configureApiRoutes`. Exporter читає справжній AppModule у Nest preview mode: не викликає конструктори providers, lifecycle hooks, TypeORM initialize або HTTP listen. Лише в окремому процесі exporter за відсутності DATABASE_URL задається placeholder URL для валідації конфігурації; production bootstrap не має такого fallback.

Звичайний `tsc` або `ts-node` не запускає compiler plugin: для production/dev потрібні команди Nest CLI, а для Jest налаштовано AST transformer. Після зміни plugin options перезапусти watch-процес; чиста збірка очищає dist.

## 7. Наступні задачі

Перший наступний інкремент — Identity: нормалізація email, hashing, sessions, verify/reset challenges, CSRF та rate limits. Потім snapshots/files/outbox і ownership. Scope і залежності залишаються у файлі 07; цей каркас не закриває дослідницькі spikes MCP/OAuth/Typst/Tinymist.

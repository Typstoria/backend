# Приватні проєкти

Потрібен Bearer-токен підтвердженого власника. Чужі, відсутні та видалені проєкти повертають 404. MCP direct mutations заборонені також в application services.

## Створення та повтори

`POST /api/projects` приймає `{ "title": "Дипломна робота" }` і `Idempotency-Key`. Назва обрізається по краях, 1–200 символів без керівних. Ключ містить 1–128 letters/digits або `. _ ~ -`.

Одна транзакція створює Project, сталий FileIdentity для порожнього `main.typ`, immutable snapshot, accepted revision №1, pending Git mapping, audit та idempotency result. Байти публікуються до DB references. Rollback може залишити unreferenced immutable bytes до GC, але не частково створений project.

Відповідь 201: projectId, revisionId, revisionNumber=1, mainFileId, manifestHash, historySyncStatus=pending. Внутрішні storage/blob/snapshot IDs не повертаються.

Повтор того самого session/key/title повертає збережений результат без нової revision або blob I/O; інший payload — 409 `IDEMPOTENCY_CONFLICT`. Authentication та активність/власність project перевіряються перед replay. Після rollback ключ можна використати знову.

Project завжди має current revision: bootstrap резервує revision ID, а deferred composite FK перевіряє завершений граф при commit. Наступна прийнята revision використовує nextRevisionNumber під project row lock. Цю гарантію БД збережено.

## Читання

- `GET /projects`: активні власні проєкти, `id DESC`, limit=20 (до 100), exclusive cursor, `nextCursor=null` наприкінці.
- `GET /projects/:id`: title, currentRevisionId, timestamps.
- `GET /projects/:id/state?revisionId=…`: вибрана immutable revision, file tree, entrypoint, context та актуальний Git status. Project metadata завжди описують поточний project.
- `GET /projects/:id/files/:fileId?revisionId=…`: UTF-8 text конкретного file identity у вибраному стані; binary читається через `/download`.

IDs — canonical positive int32, інші formats/arrays і зайві query fields відхиляються. Вкладені IDs перевіряються в межах project. File ID зберігається через rename/restore. Blobs дедуплікуються в межах owner; bytes приватні й не обслуговуються static HTTP.

## Перейменування та видалення

`PATCH /projects/:id` приймає лише `{ "title": "Нова назва" }`. Два конкурентні перейменування можуть бути успішними: останній завершений запис перемагає. Metadata version/conflict protocol відсутній. Однакова назва не додає audit; content revision, snapshot та entrypoint не змінюються.

`DELETE /projects/:id` повертає 204 і ставить deletedAt. Після commit наступні reads/mutations/replays отримують 404; worker перевіряє tombstone перед publication. Snapshots/blobs/repos залишаються до майбутнього GC. Rename/delete та audit транзакційні; rename не відновлює tombstone у race.

Початковий snapshot має context='', entrypoint main.typ та canonical manifest hash. Git є асинхронною проєкцією: PostgreSQL worker читає pending mappings без outbox/Redis. Контракти save/resources/compile/history — у файлах 13–16.

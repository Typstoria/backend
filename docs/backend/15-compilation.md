# Компіляція прийнятих ревізій

`POST /api/projects/:projectId/compilations` приймає `{ "revisionId": 1 }` і повертає 202 з job. Потрібен Bearer-токен підтвердженого власника. `Idempotency-Key` не потрібний: кожний успішний запит створює окрему задачу. Request не змінює документ; синтаксично помилковий Typst можна зберегти.

`GET /compilations/:jobId` повертає status, diagnostics, revision ID, fingerprints, timestamps, `isCurrent` та `artifactAvailable`. Поточна семантика `isCurrent` — збіг revision ID із current revision проєкту; hash входів поки є повним snapshot hash, включно з context. Пізнє завершення старої задачі не перезаписує новий PDF.

`GET /compilations/:jobId/pdf` віддає приватний PDF успішного job до expiry. Без результату або після expiry — 409 `ARTIFACT_UNAVAILABLE`. Доступ перевіряється за поточною сесією та власністю проєкту. PDF має `no-store`, attachment disposition та `nosniff`.

## Durable worker

PostgreSQL `compile_jobs` — єдине джерело pending роботи. Redis, BullMQ та outbox не використовуються. Worker раз на секунду після завершення попереднього проходу вибирає до двох due jobs різних owners. Claim, глобальний ліміт двох running jobs, одна running job на owner, attempts і fencing зберігаються в БД, тому дубльована доставка/кілька процесів не опублікують застарілий результат.

```bash
npm run migration:run
npm run worker:compile:dev
# Зі збірки: npm run worker:compile
```

Worker має окремий Nest graph і не потребує Mailjet або HTTP-конфігурації. API може прийняти job без запущеного worker; задача дочекається наступного запуску. Перед проходом відновлюються прострочені running leases. Shutdown припиняє polling, чекає bounded роботи та закриває БД.

Прийнята задача належить проєкту, **logout не скасовує її**. Відкликаний токен більше не читає результат; інша чинна сесія власника може його отримати. Перед початком і publication перевіряється активний owned project. Delete скасовує publication. Requesting session ID у job не зберігається.

## Стани й межі

`queued → running → succeeded|failed|timed_out|cancelled`. Lease — 90 секунд із heartbeat раз на 20 секунд. Тимчасові `RUNNER_UNAVAILABLE`, `STORAGE_UNAVAILABLE`, `INTERNAL_ERROR` мають до трьох спроб із паузами 5/10 секунд. Втрата третьої спроби дає `WORKER_LOST`; Typst errors не повторюються автоматично. Delete дає `ACCESS_REVOKED`.

Admission: до 20 queued/running jobs на owner і 200 глобально. Перевищення — 429. PDF доступний 7 днів; expiry ще не є фізичним GC.

Diagnostics: до 100 повідомлень із безпечним message, file ID/path, severity та `range=null`. Точні UTF-16 ranges ще не реалізовані.

## Sandbox

Збережено Linux adapter: Typst 0.14.2, Bubblewrap namespaces і transient systemd user cgroup. Потрібні host Typst, bwrap, prlimit, user systemd/cgroup v2; Docker використовується лише для PostgreSQL.

- 512 MiB RAM, без swap, 1 CPU, 32 tasks, 30 секунд lifetime.
- Read-only input/runtime, окремий output і tmpfs; без host home, секретів та мережі.
- До 25 MiB PDF та 256 KiB stdout/stderr; timeout/abort зупиняє cgroup.
- Новий workspace для кожної спроби; контекст не потрапляє у filesystem компілятора.
- Embedded/project fonts, порожній контрольований package catalog; runtime downloads відсутні.
- Немає fallback на незахищений запуск CLI.

Fingerprint враховує executable і runner policy. Production provisioning має відтворити ці гарантії.

```bash
npm run test:integration
TYPST_BINARY_PATH=/absolute/path/to/typst npm run test:compiler
TEST_TYPST_BINARY_PATH=/absolute/path/to/typst npm run test:integration
```

Integration перевіряє справжні PostgreSQL polling, claim/retry/fencing, ownership, logout/delete та artifact storage. Остання команда додатково перевіряє API → DB worker → справжній sandbox. Для `test:compiler` потрібен справжній sandbox; тести не маскують його відсутність.

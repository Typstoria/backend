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

## Sandbox компілятора

`SandboxTypstRunner` готує immutable input для спроби, збирає diagnostics, перевіряє PDF і прибирає scratch workspace. Runtime ізольовано за `TypstSandbox` з двома адаптерами: типовий `DockerTypstSandbox` та явний `LinuxTypstSandbox`. Docker runner є стандартним (`TYPST_RUNNER=docker`); Linux вибирається через `TYPST_RUNNER=linux`. Помилка обраного runner повертається як помилка компіляції: перемикання або запуск Typst CLI без sandbox не відбувається.

Docker runner запускає окремий ephemeral контейнер для кожної спроби через host Docker CLI. Він використовує digest-pinned multiarch Typst 0.14.2 image за замовчуванням:

```text
ghcr.io/typst/typst:0.14.2@sha256:b756590c0713ca5707654f3035e345c1d25dece2051817c11cc5591ae89992d4
```

Змінні worker:

| Змінна                     | Значення за замовчуванням | Призначення                                      |
| -------------------------- | ------------------------- | ------------------------------------------------ |
| `TYPST_RUNNER`             | `docker`                  | `docker` або явна альтернатива `linux`           |
| `TYPST_DOCKER_BINARY_PATH` | `docker`                  | Шлях до Docker CLI на host worker                |
| `TYPST_DOCKER_IMAGE`       | digest-pinned image вище  | Docker image; приймаються лише digest references |
| `TYPST_BINARY_PATH`        | `/usr/local/bin/typst`    | Host Typst executable для `TYPST_RUNNER=linux`   |

Перед першим запуском worker завантаж image вручну. Runtime не підтягує `latest`, не завантажує образ автоматично й не перемикається на інший runner:

```bash
docker pull ghcr.io/typst/typst:0.14.2@sha256:b756590c0713ca5707654f3035e345c1d25dece2051817c11cc5591ae89992d4
npm run worker:compile:dev
```

У контейнері запускається непривілейований UID 1000:1000; root filesystem read-only. Read-only монтуються Typst runtime та лише input поточної спроби. Host output directory не монтується: PDF до 25 MiB передається через stdout pipe, stderr обмежений 256 KiB. `tmp` — bounded tmpfs; package catalog порожній і read-only. Контейнер має `--network none`, dropped capabilities, `no-new-privileges`, вбудований seccomp profile, ліміти 512 MiB RAM без swap, 1 CPU та 32 PID. Контейнер має init process та фіксований entrypoint `/bin/busybox timeout -s KILL 30 /bin/typst`. Перед його запуском worker озброює окремий довірений host watchdog із 30-секундним deadline: він переживає SIGKILL окремого worker process та видаляє контейнер, навіть якщо compiler зупинив внутрішній watchdog. Watchdog отримує лише налаштування Docker CLI й назву контейнера, без credentials БД або пошти. Timeout/cancel видаляє весь контейнер; перед компіляцією worker прибирає залишкові compiler containers старше 90 секунд. Спільний оркестратор прибирає scratch після кожної спроби, а покинуті каталоги — після години. Деталі Docker CLI flags — у [офіційній документації Docker](https://docs.docker.com/reference/cli/docker/container/run/), pinned image — у [Typst package registry](https://github.com/typst/typst/pkgs/container/typst).

Docker adapter наразі призначений для host-запуску через npm. У systemd service звичайний `KillMode=control-group` може завершити й detached watchdog разом із worker; тому за наявності `INVOCATION_ID` Docker adapter відмовляє в запуску, а не послаблює ізоляцію. Для такого Linux deployment використовується явний `TYPST_RUNNER=linux`. Docker deployment під systemd потребує watchdog в окремому unit/scope та окремої acceptance-перевірки; його provisioning у цей інкремент не входить.

Linux adapter зберігає Bubblewrap namespaces і transient systemd user cgroup: потрібні host Typst, bwrap, prlimit, user systemd/cgroup v2. Його ліміти — 512 MiB RAM без swap, 1 CPU, 32 tasks, 30 секунд; до 25 MiB PDF та 256 KiB stdout/stderr. Він не є автоматичним fallback.

Обидва adapter обмежують Typst до `/input`, ізолюють мережу та не передають host secrets. Використовуються project/embedded fonts і порожній package catalog; runtime package downloads відсутні. Fingerprint враховує executable/image та runner policy.

```bash
npm run test:integration
npm run test:compiler:docker
TEST_TYPST_DOCKER_IMAGE=ghcr.io/typst/typst:0.14.2@sha256:b756590c0713ca5707654f3035e345c1d25dece2051817c11cc5591ae89992d4 npm run test:integration
```

`test:compiler:docker` запускає compiler tests з реальним Docker sandbox. Integration слід запускати з `DATABASE_URL` окремої тестової БД: перевірки черг обробляють доступні pending jobs, тому робоча БД з користувацькими даними для них непридатна. Integration перевіряє PostgreSQL polling, claim/retry/fencing, ownership, logout/delete та artifact storage. Опційна команда з `TEST_TYPST_DOCKER_IMAGE` додатково проходить API → DB worker → справжній Docker sandbox. Для компіляції потрібен робочий Docker daemon і завантажений pinned image.

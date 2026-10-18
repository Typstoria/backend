# Безпека, розгортання та експлуатація

Статус: запропонована технічна політика v0.1. Публічне серверне розгортання погоджено; конкретний хостинг, бюджет і навантаження ще не задані.

## 1. Межі довіри

Недовірені: HTTP/MCP запити, Typst-текст, архіви, PDF/SVG/XLSX, context materials, URL OAuth client metadata, remote Git state та відповіді зовнішнього ШІ.

Довірені компоненти мають різні можливості: API керує доменним станом, workers виконують визначені задачі, runner компілює лише переданий snapshot. Ні текст документа, ні MCP tool call не можуть задавати executable, довільний CLI flag, server path чи команду Git.

Інструкції всередині контекстних матеріалів — дані для клієнта, не серверні правила. Сервер перевіряє scopes і proposal policy незалежно від поведінки LLM.

## 2. Облікові записи та credentials

- Паролі хешуються Argon2id через підтримувану бібліотеку; параметри підбираються вимірюванням на сервері. Готовий hash не повертається через DTO.
- Реєстрація, login, resend і forgot password мають rate limit та загальні відповіді, які не розкривають існування email.
- Verify/reset challenge випадковий, одноразовий, з hash у БД і expiry. Використання позначається атомарно. Reset не входить у систему автоматично.
- Запропонована політика: до email verification можна лише підтверджувати адресу, повторно отримувати лист і виходити; проєкти, PAT та OAuth consent доступні після verification.
- Вебсесії з HttpOnly/Secure cookie, SameSite, CSRF та rotation після login. Logout відкликає конкретну сесію; reset password відкликає попередні sessions та OAuth refresh grants. PAT можна відкликати окремо або всі разом.
- PAT секрет показується один раз. SHA-256/HMAC для випадкового secret з високою ентропією допустимий; password hashing для нього не потрібен. Порівняння секретів constant time.
- OAuth provider використовує production adapter у PostgreSQL, ротацію signing keys, перевірку audience, redirect URI, PKCE та refresh reuse. In-memory demo provider не підходить.
- GitHub App private key, SMTP secret, signing keys і storage credentials — тільки secrets environment/secret store. GitHub access token отримує worker; його немає в проєктному Git config або backup archive.
- Відкликання перевіряється на кожній новій операції. Для вже запущеної задачі також перевіряється актуальний дозвіл перед публікацією; приватний артефакт завжди читається з повторною authorization.

## 3. Ізоляція компіляції

Runner виконує **одну компіляцію в окремому sandbox/container**, не від імені процесу API. Оркестратор runner — довірений внутрішній сервіс з rootless runtime на host; це єдиний компонент, що створює sandbox. Host Docker socket не монтується в API, MCP чи сам compiler container.

У sandbox:

- непривілейований UID, read-only root filesystem;
- тільки input цього job як read-only mount, окремий output і bounded tmpfs;
- вимкнена мережа, немає PostgreSQL/Redis/storage credentials;
- CPU/memory/PID/output/time limits, `no-new-privileges`, dropped capabilities, seccomp;
- мінімальний allowlisted environment, фіксовані binary, fonts/packages;
- запуск без shell і без виконання довільних precompile scripts;
- завершення всього process tree при timeout/cancel, прибирання scratch space.

Вхід Typst обмежується `--root` для job workspace. Typst сам обмежує файлові шляхи [project root](https://typst.app/docs/reference/foundations/path/), але це не замінює ОС-ізоляцію і ресурсні ліміти.

Пакети попередньо завантажує окремий контрольований процес. Для кожної компіляції фіксуються версії та хеші package catalog і fonts. Довільний package download у compiler network namespace не дозволяється. Якщо пакет відсутній, повертається діагностика з його назвою, а не непередбачуваний fetch.

LSP/Tinymist і парсери context materials також обробляють недовірений вміст, тому мають ізольовані процеси/сесії, квоти й timeout. Вебдовірені credentials не передаються в їхній environment. Preview не отримує менш суворих прав, ніж authoritative compile.

## 4. Файли, архіви та приватний storage

- Paths — відносні POSIX, нормалізовані один раз. Заборонені absolute paths, `..`, NUL/control chars, Windows drive/UNC, `.git`, `.typstoria`, дублікати після нормалізації.
- Не можна імпортувати symlinks/hardlinks/devices, виконувані hooks чи вкладені архіви для автоматичного розпакування.
- До extraction перевіряються кількість entries, declared/uncompressed size; під час streaming extraction контролюються фактичні байти. Суперечливі назви або ZIP bomb → відхилення всього імпорту.
- Extension, MIME та фактичний формат перевіряються узгоджено. SVG не вставляється у вебсторінку як довірений HTML; preview лише через ізольований render або безпечну віддачу.
- Storage bucket приватний, без directory listing. Завантаження йде через authorized API; сирий storageKey не є публічним URL.
- Відкриття share link дає доступ лише до конкретного TemplateVersion. Token не записується в application logs; використовується Referrer-Policy. Непридатні/відкликані links не розкривають оригінальний projectId.
- Git CLI запускається з відключеними hooks, обмеженим environment і власним config; path/branch/remote не можуть бути CLI option injection.
- GitHub remote обирається через відому GitHub API integration і repository ID. Довільні Git/HTTP URLs на внутрішні адреси не приймаються.

## 5. Початкові ліміти для перевірки

Це стартові конфігурації для тестування, а не виміряні можливості сервера.

| Ресурс                         | Початковий ліміт                                             |
| ------------------------------ | ------------------------------------------------------------ |
| Text file / context text       | 1 MiB кожен                                                  |
| Binary file / context material | 10 MiB                                                       |
| Поточний snapshot              | 64 MiB, до 500 файлів/матеріалів сумарно                     |
| ZIP upload                     | 32 MiB compressed, 64 MiB extracted, max expansion ratio 100 |
| Compiled PDF                   | 25 MiB                                                       |
| Compiler logs                  | 256 KiB, без secrets і host paths                            |
| Compile                        | 30 секунд, 512 MiB RAM, 1 CPU на sandbox                     |
| Compile concurrency            | Початково 2 глобально та 1 running на користувача            |
| MCP text chunk                 | 32 KiB, bounded search matches                               |
| MCP embedded PDF               | До 5 MiB; більші файли через authorized download             |
| Proposal batch                 | До 200 операцій у межах project quotas                       |
| LSP                            | До 2 sessions на користувача, idle timeout 10 хвилин         |

До публічного запуску додаються квоти загальної історії/кандидатів/артефактів на користувача, queued jobs і запитів за інтервал. Обсяг поточного snapshot сам по собі не стримує необмежений ріст історії.

## 6. Запуск

Для development Docker Compose запускає лише PostgreSQL. API, майбутні workers, Redis, storage і поштовий adapter запускаються на host; вони не додаються до локального Compose. Початковий каркас не потребує Redis, storage чи пошти для старту. Для майбутньої локальної компіляції потрібен OS sandbox без Docker; його конкретний механізм перевіряється на P0. Container runner вище описує production-варіант і не змінює локальне правило «лише БД у контейнері».

Для першого production deployment достатньо одного host із розділеними процесами й persistent volumes; масштабування до кількох host не є передумовою першої поставки. Підбір CPU/RAM робиться за load test, включно з Tinymist і extraction.

Послідовність deployment:

1. Перевірити конфігурацію й доступність backups.
2. Зібрати образи з pinned dependencies/digests; перевірити runner fingerprint.
3. Застосувати сумісні міграції окремою задачею.
4. Оновити API/workers, перевірити readiness та smoke scenarios.
5. Перевірити TLS, email links, OAuth issuer/resource URLs, MCP routing і SSE/WS proxy settings.

Публічно доступні тільки reverse proxy ports. PostgreSQL, Redis, storage admin та runner не експонуються. Secrets не зберігаються у Git. `.env.example` містить лише назви та безпечні приклади.

## 7. Черги та відновлення

Outbox і доменний job створюються в одній транзакції. Dispatcher передає jobId у BullMQ з детермінованим job ID, але доменна ідемпотентність не залежить від того, чи зберіг Redis старий queue item. [BullMQ описує унікальність ID у межах queue](https://docs.bullmq.io/guide/jobs/job-ids); після видалення job ID може бути використаний знову.

Leases/attempt tokens зберігаються в PostgreSQL. Reconciler знаходить unpublished outbox, jobs без heartbeat, Git mappings pending/failed, незавершені cleanup/backup. Кількість retries обмежена, exponential backoff із jitter; користувач бачить terminal status та дію retry.

Compile, Git projection, material extraction і GitHub backup мають окремі queues, щоб великий PDF не зупиняв пошту чи історію. Повний Redis outage не втрачає accepted revisions; queued jobs залишаються у БД й будуть передані повторно.

## 8. Спостережуваність

Структуровані logs: requestId/jobId/projectId, actor ID, код дії, duration, outcome. Не логуються passwords, tokens, email challenge links, повний Typst/context або вміст PDF.

Метрики: API error/latency, queue age, compile duration/error/timeout, worker heartbeat, storage growth, Git lag, backup age/failure, LSP session count, extraction failures. Health liveness показує життя процесу; readiness — готовність приймати відповідні операції. Збій runner не повинен забороняти читання збережених документів.

## 9. Резервні копії та перевірка відновлення

GitHub backup користувача не є backup всієї системи: там немає users/sessions, grants, proposals, анотацій і всієї службової БД. Відновлення сервісу потребує PostgreSQL dump/PITR policy, storage objects, конфігурації й захищеної копії ключів. Внутрішні Git repos можна відновити зі snapshot/mapping, але зберігати їхню копію доцільно для швидкості.

Запропоновані цілі для початкового deployment: backup щодня, RPO до 24 годин, RTO до 2 годин, 7 щоденних і 4 щотижневі копії. Вони набувають статусу перевірених тільки після restore drill.

Узгоджена копія: зафіксувати DB snapshot/backup boundary, зберегти всі blobs, на які він посилається, призупинити GC до завершення backup; metadata inventory і checksums зберігати разом. Blobs immutable, тому пізніші нові blobs не шкодять такій копії. Автоматичне очищення не повинно видаляти об'єкти активного backup.

Restore drill на чистому середовищі перевіряє login, приватний проєкт, кілька історичних ревізій, candidate proposal, context materials, компіляцію і Git reconciliation. Тільки наявність архіву без такого тесту не є виконанням вимоги відновлення.

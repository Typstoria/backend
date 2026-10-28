# Рішення, питання та джерела

Статус: журнал v0.1 від 20.10.2026. Тут відокремлено відповіді користувача, запропоновану архітектуру та результати дослідження прототипу.

## 1. Погоджено користувачем

| ID  | Рішення                                                       | Наслідок для реалізації                                                                                              |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| U01 | TypeScript + NestJS                                           | SmartTeX на Python/Django використовується як матеріал для аналізу; реалізація нова                                  |
| U02 | Увесь другий етап також обов'язковий                          | Git, review, multi-file, templates/shares, editor, transfer, materials, OAuth не позначаються необов'язковим backlog |
| U03 | MCP універсальний                                             | Стандартний transport/tools/resources/OAuth, відсутня залежність від виробника LLM; потрібна матриця клієнтів        |
| U04 | Публічний сервер, сайт через інтернет                         | TLS, ізоляція користувачів/runner, production sessions, restore та limits входять до плану                           |
| U05 | Усі ШІ-правки спочатку підтверджуються користувачем           | MCP не має direct write/accept; review працює вже у першій наскрізній демонстрації                                   |
| U06 | GitHub зберігає резервну копію з Typstoria                    | Односторонній push; pull/merge зовнішніх змін не реалізується                                                        |
| U07 | Некомпільовані ШІ-правки можна прийняти з явним попередженням | Окремий web acknowledgement прив'язаний до перевіреної candidate version                                             |
| U08 | TypeORM замість Prisma                                        | Entities, repositories та явні міграції; synchronize вимкнений у всіх середовищах                                    |
| U09 | Для локального запуску тільки БД у контейнері                 | Compose містить лише PostgreSQL, API та інші процеси запускаються на host                                            |
| U10 | Потрібен Swagger                                              | UI `/docs`, JSON `/docs-json`, DTO і schemas фактичних endpoints                                                     |

| U11 | Mailjet для підтвердження пошти та відновлення пароля | Send API v3.1 у всіх середовищах, ключі в environment, без локального збереження листів |

| U12 | Один Bearer access token без refresh/cookies | Login повертає accessToken, приватні запити передають Authorization header; CSRF-токен та anonymous cookie прибрано |

| U13 | Числові ID сутностей | PostgreSQL integer auto-increment; JSON number; окрема міграція наявних UUID зі збереженням зв’язків |

| U14 | Обов’язкове підтвердження пошти до входу; повторний лист раз на 5 хвилин | Register автоматично надсилає лист, login до verify повертає 403 без токена; verify/reset не авторизують, reset не підтверджує пошту |

| U15 | Вхід через Google; підтвердження Google достатньо без додаткового листа | Google Identity Services, server-side ID token verification; один Bearer Typstoria; Google Client ID налаштовується окремо |

Відповіді U02/U05 змінюють пріоритети вихідного бачення: один файл і пряме внесення ШІ-змін не є достатньою фінальною версією. Вихідні TXT не редагувалися, їхні початкові формулювання збережено для простежуваності.

## 2. Запропоновані технічні рішення

Ці рішення сформульовані для конкретного плану. Вони не подаються як уже обрані користувачем бібліотеки.

| ADR | Пропозиція                                           | Причина / альтернативи                                                                                 | Як перевірити                                               |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| A01 | Модульний моноліт + workers                          | Єдина доменна модель; мікросервіси додають узгодження без початкової потреби                           | Пройти повний use case через REST/MCP без дублювання policy |
| A02 | PostgreSQL + TypeORM                                 | Транзакції/constraints; TypeORM погоджено користувачем; synchronize вимкнений, схему змінюють міграції | Atomic batch, CAS, durable jobs integration test            |
| A03 | Immutable snapshots і blobs                          | Один вхід для compile/diff/review/restore; спільний mutable workspace створює гонки                    | Concurrent save, old/new compile, proposal candidate test   |
| A04 | Git як відновлювана проєкція прийнятих ревізій       | БД і Git не мають спільного commit; синхронний dual write створює неоднозначні збої                    | Crash/retry до і після Git ref/mapping                      |
| A05 | PostgreSQL durable jobs + polling workers            | Redis/BullMQ/outbox вилучені; pending записи є джерелом роботи                                         | Claim/fencing/retry/restart tests                           |
| A06 | S3-compatible private storage                        | Відокремлення байтів від домену; local filesystem adapter лише для dev                                 | Upload failure, orphan GC, authorized download              |
| A07 | Офіційний MCP TypeScript SDK v2 як вихідний кандидат | Поточна stable лінія реалізує редакцію 2026-07-28; v1 розглядається лише для перевіреної сумісності    | Pin exact release і перевірити потрібні clients/protocols   |
| A08 | OAuth provider library; кандидат oidc-provider       | Підтримувані протокольні механізми замість власної реалізації                                          | MCP discovery/resource/consent/PKCE/revocation spike        |
| A09 | Один непрозорий Bearer-токен із серверним записом    | Непрозорі credentials і просте revocation для браузера                                                 | Bearer/expiry/logout/reset tests                            |
| A10 | Isolated per-job Typst runner                        | Недовірений текст і ресурсоємні обчислення; root flag не забезпечує OS isolation                       | Filesystem/network/timeout/memory tests                     |
| A11 | Tinymist для редактора                               | Готовий language service; власний parser/LSP надто великий окремий проєкт                              | Completion/format/position/outline/session isolation        |
| A12 | GitHub App для backup                                | Окремі обмежені installation permissions; не змішувати з MCP OAuth                                     | Repo selection/token refresh/push conflict/revocation       |
| A13 | Всі project mutations від MCP — proposal             | Послідовне тлумачення «всі правки»: також context/annotations                                          | Відсутність обхідного REST або upload apply path            |

## 3. Відкриті питання

| ID  | Питання                                                               | Поточний підхід у плані                                                                               | Коли потрібна відповідь                                      |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Q01 | Який дедлайн і склад backend/frontend команди?                        | Без календарних обіцянок, dependency plan P0–P9                                                       | Для оцінки строків і розподілу робіт; питання вже поставлено |
| Q02 | Який host/budget, очікувані користувачі та розміри документів?        | Один production host; ліміти і цілі є гіпотезами                                                      | Перед benchmark і deployment                                 |
| Q03 | Які перші системні шаблони й вимоги до оформлення?                    | Пропонується технічна специфікація, опис архітектури, інструкція користувача; зміст ще не затверджено | До fixtures/system templates                                 |
| Q04 | Чи включати контекст/матеріали у зовнішню резервну копію?             | Окремий includeContext у налаштуваннях із preview; за замовчуванням false                             | До Backup UI і приймання F18                                 |
| Q05 | Точні retention, account quotas, email policy та максимальні uploads? | Запропоновані значення у файлі 06, конфігуровані                                                      | До публічного запуску                                        |
| Q06 | Які два реальні MCP-клієнти входять у початкову acceptance matrix?    | Універсальний API + SDK test client; реальні clients обираються на P0                                 | До завершення MCP spike                                      |

Ці питання не блокують створення документації та базових модулів. Підтримка типів матеріалів, публічний read-only template snapshot і client registration policy описані як запропоновані межі; їх можна уточнювати без зміни U01–U07.

## 4. Що досліджено в SmartTeX

Джерело: локальна папка `/home/yehor/Downloads/SmartTeX-master/`. Це вибірковий статичний аналіз структури та ключових місць коду, не повний аудит і не підтвердження працездатності прототипу. SmartTeX не запускався, його код не копіювався й не змінювався.

| Місце прототипу                                                        | Спостереження                                                                              | Висновок для Typstoria                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `projects/models.py:18`, `:106`                                        | Project пов'язаний з owner; ProjectVersion має actor/source/before/after і metadata        | Явне авторство й канал корисні; нова модель версіонує весь immutable manifest                                 |
| `projects/services.py:500`                                             | Окрема перевірка файлових шляхів                                                           | Шляхи перевіряються в одному domain service; архіви потребують додаткової streaming-валідації                 |
| `projects/services.py:1933`, `:2060`                                   | Побудова команди компілятора й compile result, timeout, diagnostics                        | Відокремити Typst adapter; compile робити job із приватною директорією та exact inputs                        |
| `projects/views.py:2086`                                               | HTTP handler викликає `compile_project` і записує результат                                | У новому API handler лише ставить job; очікування compiler не займає request                                  |
| `projects/services.py:28`                                              | Semaphore налаштований у процесі Python                                                    | У NestJS потрібен загальний контроль queue/concurrency; process-local ліміт не обмежить всі replicas          |
| `accounts/models.py:9`                                                 | MCPToken має звичайне поле token і one-to-one user                                         | У новій системі кілька іменованих credentials, hash, scopes/project grants, expiry/revocation                 |
| `accounts/auth_helpers.py:28`                                          | Session і кілька token header formats зведені до user                                      | Нова модель зберігає channel/credential/scopes; MCP user не отримує web acceptance права                      |
| `mcp_http_server.py:256`, `:986`                                       | MCP adapter викликає HTTP API; багато tools в одному великому файлі                        | Концепцію adapter використати; бізнес-логіку винести у спільні Nest services, tools розділити по областях     |
| `longdoc/models.py:44`, `:117`                                         | Окремі контекстні матеріали та annotations                                                 | Контекст не змішувати з компіляційними ресурсами; anchors прив'язувати до стабільного fileId/revision         |
| `longdoc/models.py:264`, `:315`                                        | AISession/ChangeProposal мають стани перевірки, compile і review                           | Потрібен явний proposal lifecycle; наша схема не вимагає власного LLM чи small model                          |
| `templates_lib/models.py:6`                                            | Шаблон містить контент/архів, main file та defaults                                        | Для sharing використовувати конкретну immutable TemplateVersion і явний inclusion preview                     |
| `projects/tinymist_service.py`, `projects/tinymist_preview_service.py` | Language service і preview виділені окремо                                                 | Tinymist дослідити як компонент із власним session lifecycle й ізоляцією                                      |
| `docker-compose.yml`                                                   | Є web/mcp/db, окремий PlantUML; у web монтується Docker socket; Typst image заданий latest | Новому web процесу socket не потрібний; runner окремий, image pinned; PlantUML не входить до заявленого scope |

Вивчені механізми дають перелік сценаріїв і ризиків. Вони не визначають нову структуру класів, алгоритми або назви API. Локальний прототип не використовувався як джерело для перенесення готових рішень.

## 5. Як використано вихідні TXT

- «Бачення проєкту Диплом» задає предметну область та три початкові етапи; U02 переводить другий етап у mandatory scope.
- «Формування вимог» задає приватність, auth, єдиний стан REST/MCP, збереження помилкового Typst, відповідність PDF версії та негативні сценарії. Вони відображені в N01–N06 і T01–T17.
- «Аналіз аналогів» допомагає визначити review/Git/context сценарії та відмінність продукту. Оцінки аналогів із порівняльних таблиць не перевірялися заново й не подаються тут як актуальний продуктовий аудит.

## 6. Первинні технічні джерела

Перевірено 18.10.2026. Точні dependency versions будуть зафіксовані lockfile і ADR на P0; документація не встановлює бібліотеки й не заявляє, що інтеграції вже працюють.

| Джерело                                                                                                                                                                     | Для чого використано                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [NestJS queues](https://docs.nestjs.com/techniques/queues)                                                                                                                  | Історичний варіант із BullMQ; після спрощення не використовується                                                                      |
| [TypeORM transactions](https://typeorm.io/docs/advanced-topics/transactions/)                                                                                               | Транзакції та optimistic concurrency; доменний CAS описано окремо                                                                      |
| [MCP Streamable HTTP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)                                                 | Transport, version-specific lifecycle, Origin/auth validation                                                                          |
| [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)                                                                | OAuth discovery, protected resource, audience/resource та scopes                                                                       |
| [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)                                                                                          | Tool schemas, results та protocol errors                                                                                               |
| [Офіційний TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)                                                                                          | Поточна stable v2; нові packages `@modelcontextprotocol/server` / `@modelcontextprotocol/client`; старі v1 приклади не змішуються з v2 |
| [SDK v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/)                                                                                                          | Вихідна документація для spike; точний API перевіряється за pinned release                                                             |
| [Typst paths/project root](https://typst.app/docs/reference/foundations/path/)                                                                                              | Файлові межі Typst і `--root`                                                                                                          |
| [Typst syntax](https://typst.app/docs/reference/syntax/)                                                                                                                    | Структура джерел і потреба в parser-aware outline                                                                                      |
| [Tinymist repository](https://github.com/Myriad-Dreamin/tinymist)                                                                                                           | Language service й editor integration; потрібна власна server isolation                                                                |
| [git update-ref](https://git-scm.com/docs/git-update-ref)                                                                                                                   | Оновлення ref із перевіркою попереднього значення                                                                                      |
| [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids)                                                                                                                 | Історичний варіант; Redis transport вилучено                                                                                           |
| [oidc-provider](https://github.com/panva/node-oidc-provider)                                                                                                                | Кандидат OAuth server library з PKCE, discovery, resource indicators і revocation                                                      |
| [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) | Окрема автентифікація backup worker до GitHub                                                                                          |

## 7. Наступне оновлення документації

Після відповіді на Q01–Q03 уточнити календарний план і template fixtures. Після P0 записати exact versions, результати експериментів та підтверджені ADR; потім додати ERD/OpenAPI, згенеровані з фактичної реалізації. Не називати ці артефакти готовими до того, як їх створено і перевірено.

## Реалізований локальний runner P3

Рішення A10 для Linux development конкретизовано й перевірено: Typst 0.14.2 у Bubblewrap 0.6.1 під systemd user service з cgroup limits, без додаткового Docker-контейнера. Durable jobs після спрощення працюють безпосередньо через PostgreSQL. Протокол, fingerprint policy, негативні сценарії й поточні межі (порожній package catalog, range=null, production provisioning) — у [15-compilation.md](15-compilation.md). Це не закриває інші spikes P0 або Git частину P3.

## Реалізована Git-проєкція P3

A04 перевірено реальним Git 2.34.1: bare repo на проєкт, immutable blobs/tree, детермінований commit-tree, CAS update-ref, відновлення після ref/DB failure та втрати repo. History/diff/restore працюють із PostgreSQL незалежно від Git worker. Поточний протокол, межі й тестові сценарії — у [16-git-history.md](16-git-history.md). GitHub backup залишається окремим P8 і не запускається цим інкрементом.

# MCP через OAuth (P5)

Typstoria має Streamable HTTP endpoint `/mcp` без прив’язки до постачальника AI. Він підтримує редакцію MCP 2026-07-28 і сумісний stateless режим 2025 через офіційний SDK v2. Основні вебмаршрути надалі приймають лише вебтокени; OAuth access tokens працюють тільки на поверхні MCP.

## OAuth-підключення

Локальний MCP за замовчуванням слухає канонічний `http://127.0.0.1:PORT`. Для OAuth задайте `MCP_OAUTH_COOKIE_KEY` — 32 випадкові байти у base64url — і перезапустіть API. Для production задайте `MCP_PUBLIC_ORIGIN=https://your-api.example.com` і збережіть ключ між перезапусками. Reverse proxy має передати канонічний Host і обслуговувати TLS; rate limit на edge за потреби відділяє клієнтів за IP. У застосунку OAuth має додаткові ліміти за адресою прямого з’єднання і загальний ліміт.

Відкрийте **Обліковий запис → Підключення застосунків** і скопіюйте адресу MCP. Додайте її до клієнта з підтримкою OAuth. Клієнт отримує challenge із protected resource metadata, знаходить authorization server і реєструє public client через Dynamic Client Registration. Далі браузер відкриває сторінку Typstoria: увійдіть вебакаунтом і виберіть проєкти. Сторінка показує назву клієнта, адресу повернення та всі запитані дозволи до підтвердження. Для Google-only акаунта можна вставити чинний вебтокен у форму на цій сторінці.

| Маршрут                                             | Призначення                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource/mcp`     | URL ресурсу, його scopes і authorization server                        |
| `GET /.well-known/oauth-authorization-server/oauth` | Discovery сервера, реєстрація, авторизація, token/revocation endpoints |
| `POST /oauth/reg`                                   | Реєстрація public client                                               |
| `GET /oauth/auth`                                   | Authorization Code з PKCE S256 і браузерним consent                    |
| `POST /oauth/token`                                 | Одноразовий code exchange або refresh                                  |
| `POST /oauth/token/revocation`                      | Відкликання токена клієнтом                                            |
| `GET /api/access/oauth`                             | Доступність OAuth і адреса MCP                                         |
| `GET /api/access/connections`                       | Список OAuth-підключень вебвласника                                    |
| `DELETE /api/access/connections/:id`                | Відкликання всього підключення                                         |

OAuth access token — 10 хвилин; грант діє до 30 днів від consent. Refresh ротується; повтор уже використаного refresh відкликає сімейство. Відкликання через Typstoria блокує і MCP, і refresh. Токен прив’язаний до точного канонічного URL `/mcp`, а доступ обмежений вибраними проєктами й погодженими scopes. Redirect URI має бути зареєстрованим HTTPS або локальним loopback HTTP. Віддалені Client ID Metadata Documents і confidential clients не підтримуються; клієнту потрібна підтримка Dynamic Client Registration.

## MCP tools і перевірка

| Область          | Tools                                                                  | Потрібні права                                                                                                        |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Проєкти          | `list_projects`, `get_project`                                         | projects:read                                                                                                         |
| Файли й контекст | `list_files`, `read_file`, `get_context`, `search_project`             | documents:read для джерел, context:read для контексту                                                                 |
| Історія          | `list_versions`, `read_version`, `diff_versions`                       | history:read; diff також documents:read і context:read                                                                |
| Пропозиції       | `create_proposal`, `update_proposal`, `get_proposal`, `list_proposals` | changes:propose для запису чернетки, changes:read для читання; зміни й diff потребують доступу до відповідного вмісту |
| Ресурси          | `stage_upload`                                                         | uploads:stage; base64 одного бінарного файла до 512 KiB                                                               |
| Перевірка        | `validate_proposal`, `get_proposal_validation`                         | changes:propose/read; для компіляції також documents:read і compile:run/read відповідно                               |
| Компіляція       | `compile_project`, `get_compile_result`                                | documents:read і compile:run/read; для читання preview також changes:read                                             |

Після `list_files` використовуйте його `revisionId` для наступних читань. `read_file` і `get_context` повертають текст частинами (UTF-16, `nextOffset`). `search_project` шукає літеральний рядок у файлах або контексті конкретної ревізії; `nextCursor` продовжує пошук. Для клієнта лише на читання достатньо `projects:read` і `documents:read`. Доступ обмежено 1–50 проєктами на підключення і 30 активними підключеннями на акаунт. Зміна пароля відкликає OAuth-доступ. Пошук по матеріалах та outline додаються разом із P6/P8.

Наскрізний сценарій:

1. `list_projects` → `list_files` → `read_file`.
2. `create_proposal` із `baseRevisionId` та тими самими `operations`, що у вебзбереженні. Поточна ревізія не змінюється.
3. `get_proposal` (за потреби `includeDiff: true`) → `validate_proposal` з `expectedProposalVersion`.
4. `get_proposal_validation` і `get_compile_result`. Для готового PDF використати `pdfUri` через `resources/read` (до 2 MiB) або `pdfDownloadUrl` із тим самим Bearer-токеном. URL не містить токена.
5. Користувач приймає пропозицію через вебreview [P4](18-proposals.md). MCP не публікує accept/reject, пряме редагування, restore або delete.

Реалізація: `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2, `oidc-provider` 9.14.0. Див. [офіційний SDK](https://github.com/modelcontextprotocol/typescript-sdk), [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) і [MCP Inspector](https://github.com/modelcontextprotocol/inspector). Інтеграційні тести використовують офіційний клієнт SDK 2.4.0 через HTTP з OAuth. MCP Inspector 2.15.0 окремо перевірено локально: список інструментів, читання, створення пропозиції, sandbox-компіляція та отримання PDF; віддалені клієнти, що потребують публічний HTTPS, перевіряються при розгортанні.

Міграція `AddMcpAccess1794506400000` додає таблиці `mcp_access_grants` (дозволи) і `mcp_oauth_records` (стан провайдера). Вона не переписує наявні таблиці. Міграція `RetireMcpPat1795096800000` позначає раніше видані персональні токени відкликаними та зберігає OAuth-підключення. Перед запуском нового коду застосувати `npm run migration:run`.

## Локальний запуск

12.11.2026 міграцію застосовано до локальної БД `typstoria`. Перевірено відновлення backup, кількість записів у попередніх таблицях і відповідність схеми TypeORM. Локальний API та обидва workers запущені через `systemd --user`. Для OAuth сервіс `typstoria-api` читає ключ із локального ігнорованого `.local/mcp-oauth.env`. При ручному запуску API цей ключ треба передати окремо.

Swagger: [127.0.0.1:3000/docs](http://127.0.0.1:3000/docs). MCP: `http://127.0.0.1:3000/mcp`. Обидва health endpoints і discovery відповідають 200; приватні маршрути без токена — 401.

# Контракти REST, MCP та подій

Статус: проєктні контракти v0.1. Реалізація має опублікувати OpenAPI для REST та JSON Schema для MCP. Приклади нижче пояснюють цільову поведінку. Фактично реалізовані Identity endpoints описано у [10-authentication.md](10-authentication.md) і автоматичному OpenAPI; решта прикладів поки не реалізована.

## 1. Спільні правила

- REST prefix `/api`; JSON camelCase; ідентифікатори сутностей — додатні цілі числа (int32); дати ISO 8601 UTC.
- У концептуальних прикладах нижче сутності іноді позначені зрозумілими підписами; реальний API приймає та повертає їхні числові ID.
- Ліміти body, рядків, pagination і типів перевіряються DTO/schema до application service.
- Mutation основного документа вимагає `baseRevisionId`; proposal — також expectedProposalVersion. Зміна title вимагає expectedMetadataVersion; анотації — expectedAnnotationVersion.
- Для create, save batch, accept, restore, compile, import/export і backup використовується `Idempotency-Key`. У MCP відповідний аргумент `idempotencyKey`. Ключ обмежений actor/credential, операцією та payload hash; повтор з іншим payload → `409 IDEMPOTENCY_CONFLICT`.
- Перевірка idempotency виконується перед повторною перевіркою baseRevision, але після перевірки чинності actor й доступу. Повтор успішної операції не маскує відкликані credentials.
- Списки мають cursor pagination, default 20/max 100. Пошук і читання тексту підтримують обмежені chunks.
- Приватний чужий або видалений ресурс → 404 без розкриття існування. Немає автентифікації → 401; недостатньо scope до власного ресурсу → 403.
- Спочатку HTTP/WS/SSE authentication, потім application authorization. ID ресурсу й секрет share link не є загальним правом на довільний resource.

Формат REST-помилки:

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "Проєкт змінився після відкриття цієї версії.",
    "details": { "currentRevisionId": "revision-new" },
    "requestId": "request-id"
  }
}
```

Коди: 400 invalid schema; 401/403/404 доступ; 409 state conflict; 413 size limit; 415 unsupported type; 422 structural validation; 429 quota/rate limit; 503 temporary dependency failure. Typst error — результат CompileJob, а не HTTP 422 для успішно створеного job.

## 2. REST поверхні

| Область          | Запропоновані маршрути                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth             | `POST /auth/register`, `/login`, `/logout`, `/verify-email`, `/resend-verification`, `/forgot-password`, `/reset-password`, `GET /auth/me`                    |
| PAT              | `GET/POST /access/tokens`, `DELETE /access/tokens/:id`                                                                                                        |
| OAuth grants     | `GET /access/connections`, `DELETE /access/connections/:id`                                                                                                   |
| Projects         | `GET/POST /projects`, `GET/PATCH/DELETE /projects/:p`                                                                                                         |
| Current snapshot | `GET /projects/:p/state` → currentRevision, tree, context summary, compile summary                                                                            |
| Files            | `GET /projects/:p/files?revisionId=…`, `GET /projects/:p/files/:fileId?revisionId=…`                                                                          |
| Atomic changes   | `POST /projects/:p/changes` → add/update/rename/move/delete/entrypoint/context/material operations                                                            |
| Staging upload   | `POST /projects/:p/uploads`, `GET /projects/:p/uploads/:id` → tenant/project-bound staged blob                                                                |
| Materials        | `GET /projects/:p/materials?revisionId=…`, `GET /projects/:p/materials/:id/content`, `/extraction`, `/download`                                               |
| Search           | `POST /projects/:p/search` → revisionId, область source/context/materials, bounded matches                                                                    |
| Compile          | `POST /projects/:p/compilations`, `GET /projects/:p/compilations/:job`, `GET /projects/:p/compilations/:job/pdf`                                              |
| History          | `GET /projects/:p/revisions`, `GET /projects/:p/revisions/:r`, `/diff?against=…`, `POST /projects/:p/restore`                                                 |
| Proposals        | `GET/POST /projects/:p/proposals`, `GET/PATCH /projects/:p/proposals/:s`, `POST …/:s/validate`, `/accept`, `/reject`, `/rebase`                               |
| Annotations      | `GET/POST /projects/:p/annotations`, `PATCH/DELETE /projects/:p/annotations/:id`                                                                              |
| Templates        | `GET /templates`, `GET /templates/:id/versions/:v`, `POST /projects/:p/template-versions`, `POST /templates/:id/copies`                                       |
| Share links      | `POST /templates/:id/versions/:v/shares`, `DELETE /template-shares/:id`, `GET /shared/templates/:token`, `POST …/:token/copies`                               |
| Transfer         | `POST /imports`, `GET /transfers/:job`, `POST /projects/:p/exports`, `GET /transfers/:job/download`                                                           |
| GitHub           | `GET /integrations/github/install-url`, callback, `GET/DELETE /integrations/github`, `GET/PUT /projects/:p/backup`, `POST …/backup/runs`, `GET …/backup/runs` |
| Editor           | `POST /projects/:p/editor-sessions`, `DELETE /editor-sessions/:id`, authenticated LSP WebSocket, `GET /projects/:p/outline?revisionId=…`                      |
| Events           | `GET /projects/:p/events` — браузерний SSE, події без повного тексту документів                                                                               |
| Health           | `/health/live`, `/health/ready`; readiness деталізується внутрішньо                                                                                           |

Маршрути файлів використовують fileId; шлях передається у JSON і не потрапляє безпосередньо до серверного filesystem path. Усі вкладені ID перевіряються разом із projectId.

`POST /changes` із вебсесією може змінювати основний проєкт. MCP credentials на цьому маршруті не приймаються. MCP створює proposal через окремий application use case. Заборона прямого запису перевіряється також на рівні policy.

## 3. Приклади операцій

Ручне збереження batch:

```json
{
  "baseRevisionId": "revision-10",
  "summary": "Оновлено розділ архітектури",
  "operations": [
    { "type": "updateText", "fileId": "file-main", "content": "= Архітектура\nТекст розділу." }
  ]
}
```

Відповідь: `revisionId`, `revisionNumber`, `manifestHash`, `historySyncStatus`. Повтор того самого ключа повертає той самий результат.

Прийняття proposal з помилкою компіляції:

```json
{
  "baseRevisionId": "revision-10",
  "expectedProposalVersion": 3,
  "validationId": "validation-3",
  "acknowledgeCompileFailure": true
}
```

`acknowledgeCompileFailure` не замінює validation і не дозволяє прийняти invalid paths, відсутній entrypoint чи неперевірений candidate. UI має спочатку показати фактичні помилки компіляції. Прапорець не додається frontend автоматично.

Compile response, GET job після завершення:

```json
{
  "id": "compile-job",
  "revisionId": "revision-10",
  "status": "failed",
  "errorCode": "TYPST_ERROR",
  "inputManifestHash": "sha256-example",
  "compilerFingerprint": "runner-fingerprint",
  "isCurrent": true,
  "artifactAvailable": false,
  "diagnostics": [
    {
      "fileId": "file-main",
      "path": "main.typ",
      "severity": "error",
      "message": "unclosed delimiter",
      "range": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 5 } }
    }
  ]
}
```

Позиції range — нумерація з нуля, UTF-16, як у LSP. Adapter компілятора явно перетворює його власні байтові/символьні позиції. Якщо точну позицію визначити не вдалося, `range=null`; повідомлення зберігається без вигаданих координат. Абсолютні серверні шляхи видаляються.

Для proposal compile поле revisionId = null; повертаються proposalId, candidateSnapshotId і candidateVersion. Такий PDF позначений як preview пропозиції. Авторизоване читання candidate не дозволяє використати його ID замість прийнятої revisionId в інших операціях.

## 4. MCP tools

| Tool                                               | Призначення                                                                                           | Scope                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `list_projects`                                    | Тільки власні дозволені проєкти                                                                       | `projects:read`                                           |
| `get_project`                                      | Метадані, current revision, доступні можливості                                                       | `projects:read`                                           |
| `list_files` / `read_file`                         | Дерево та bounded content конкретної ревізії                                                          | `documents:read`                                          |
| `search_project`                                   | Пошук із provenance та лімітами                                                                       | Scope відповідної області                                 |
| `get_context` / `list_materials` / `read_material` | Контекст і chunks витягів                                                                             | `context:read`                                            |
| `get_outline`                                      | Розділи та джерельні позиції                                                                          | `documents:read`                                          |
| `list_annotations`                                 | Коментарі та історичні anchors                                                                        | `annotations:read`                                        |
| `list_versions` / `read_version` / `diff_versions` | Історія та порівняння                                                                                 | `history:read`                                            |
| `create_proposal`                                  | Draft із baseRevision і typed operations                                                              | `changes:propose` та read scopes змінюваних областей      |
| `update_proposal`                                  | Нова версія candidate з expectedProposalVersion                                                       | `changes:propose`                                         |
| `validate_proposal`                                | Structural checks і candidate compile                                                                 | `changes:propose`, `compile:run` якщо потрібна компіляція |
| `get_proposal` / `list_proposals`                  | Diff, validation, status                                                                              | `changes:read`                                            |
| `stage_upload`                                     | Обмежений binary/text upload для майбутньої proposal operation, без застосування до основного проєкту | `uploads:stage`                                           |
| `compile_project`                                  | Асинхронна компіляція конкретної ревізії                                                              | `compile:run`                                             |
| `get_compile_result`                               | Job status, diagnostics, metadata/URI PDF                                                             | `compile:read`                                            |

`create_proposal` може містити `updateText`, `createFile`, `deleteFile`, `renameFile`, `setEntrypoint`, `updateContext`, `attachMaterial`, `createAnnotation`, `resolveAnnotation`. Операції типізовані, без shell, довільного SQL або доступу до server path. Великий binary upload іде через захищений staging upload: об'єкт залишається недоступним основному документу до прийняття proposal. На цій поверхні credential має окремий обмежений дозвіл `uploads:stage`, який не дає права застосувати blob.

`accept_proposal`, `write_current_file`, `delete_project` і керування credentials не публікуються як MCP tools. Tool annotations описують read-only/destructive behavior для клієнта, але сервер ніколи не покладається на них як на authorization.

Усі читання повертають revisionId/content hash; зміни — proposalId/candidateVersion. Для однакової бази клієнт має повторно читати ту саму ревізію. Якщо permission відкликано, наступне читання/дія відхиляється, навіть у вже створеному transport session.

## 5. MCP transport і універсальність

Використовуємо Streamable HTTP на `/mcp` за TLS і офіційний SDK v2 як вихідну базу. Актуальна перевірена специфікація на дату документа — [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). Різні версії мають різні правила lifecycle; handshake, version negotiation і framing делегуються обраній версії SDK. Не змішуємо вручну вимоги старого session-based протоколу з новим. Заголовок Origin, якщо присутній, перевіряється за allowlist; невідоме значення → 403.

У spike фіксуємо матрицю фактично підтримуваних SDK/client/protocol versions. Якщо стабільний SDK або потрібний клієнт ще працює з попередньою редакцією, підтримуємо перевірений сумісний режим; не оголошуємо повну підтримку 2026-07-28 без тесту.

Transport errors і JSON-RPC errors відокремлені від помилок виконання tools. Domain failure повертається як tool result з `isError=true` та кодом помилки. Structured output і текстове пояснення використовуються там, де їх підтримує обрана редакція протоколу. Формат tool schemas перевіряється contract tests.

PDF доступний як protected HTTPS endpoint і MCP resource `typstoria://projects/{p}/compilations/{job}/pdf`. `resources/read` повторно перевіряє actor/project/scope та може повернути binary content із MIME `application/pdf` у межах ліміту. Для великих PDF повертаємо metadata та захищений URL завантаження: browser використовує сесію, API-клієнт — дозволений bearer credential. Токен не додається до URL; публічний media URL не створюється. Можливість показати PDF усередині чату залежить від клієнта, доступ до байтів — від нашого контракту.

Базові tools не потребують client-specific UI, sampling або певного виробника LLM. На релізі перевіряємо офіційний SDK test client та щонайменше два незалежні реальні клієнти; назви/версії записуються у release checklist.

## 6. Автентифікація та OAuth

Веб: один непрозорий Bearer access token у Authorization header, серверний запис у PostgreSQL для expiry/revocation, без auth cookies і refresh-токена. Exact allowed origins для фронтенду. Скидання пароля відкликає всі поточні web access tokens; майбутній MCP OAuth має також відкликати відповідні refresh families.

PAT: `Authorization: Bearer <secret>`, випадковий secret із public ID, у БД hash. Дозволені scopes/проєкти обирає користувач; read-only профіль не має propose чи compile:run. PAT призначений для клієнтів із налаштуванням bearer header й не замінює універсальний OAuth flow.

OAuth: Authorization Code + PKCE S256, consent із назвою клієнта, scopes і проєктами, короткі access tokens, refresh rotation/reuse detection та revocation. MCP protected-resource metadata, authorization-server discovery, resource/audience validation — за [специфікацією MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). Список registrations, redirect URI rules та client metadata discovery уточнює spike; довільні URL не можна fetch без SSRF-захисту.

У доменній БД OAuthGrant визначає остаточні permissions. Перед tool/resource дією перевіряється чинність grant і credential, щоб відкликання діяло на наступний запит. Access token audience обмежена MCP resource; він не стає вебсесією. PAT і OAuth tokens не пересилаються зовнішнім сервісам на кшталт GitHub.

## 7. Контракт із фронтендом

- Після успішного save клієнт оновлює baseRevisionId. `saved`, `compiling`, `compiled`, `compile failed`, `preview stale` — різні стани.
- SSE події: `revision.created`, `proposal.updated`, `compile.finished`, `material.extracted`, `backup.updated`, `annotation.updated`. Дані містять IDs/версії, без source text і credentials.
- SSE має event ID і обмежений replay; після розриву/пропуску клієнт робить GET state. SSE не є джерелом істини.
- Читання проєкту через MCP стає видимим у вебі після того самого commit/outbox lifecycle. До прийняття ШІ-зміни відображаються тільки в review.
- LSP WebSocket перевіряє session/Origin/project, обмежує розмір і частоту; raw internal URI Tinymist не повертаються клієнту.
- Вибір шаблону, upload/import, acceptance із compile error та склад backup потребують frontend-екранів, але бекенд надає готові metadata/status/error contracts.

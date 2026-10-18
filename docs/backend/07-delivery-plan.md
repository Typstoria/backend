# План реалізації та перевірки

Статус: v0.1. Усі інкременти нижче входять до погодженої повної поставки. Термін і склад команди поки не задані, тому план визначає залежності й результати без вигаданих календарних дат.

## 1. Послідовність

```mermaid
flowchart LR
  P0[P0 Технічні експерименти] --> P1[P1 Основа й auth]
  P1 --> P2[P2 Файли та ревізії]
  P2 --> P3[P3 Compile та Git]
  P3 --> P4[P4 Пропозиції й review]
  P4 --> P5[P5 MCP та OAuth]
  P5 --> P6[P6 Контекст та анотації]
  P6 --> P7[P7 Шаблони та transfer]
  P7 --> P8[P8 Editor та GitHub]
  P8 --> P9[P9 Інтеграція й release]
```

Це базова послідовність для одного backend developer. Після стабілізації контрактів окремі роботи P6/P7/P8 можна виконувати незалежно, але не потрібно вводити кілька сервісів або гілок розробки лише заради паралельності.

## 2. Інкременти та вихідні результати

| Етап                      | Роботи                                                                                                                                                     | Залежності         | Критерій виходу                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| P0 — ризики               | Мінімальні окремі spikes: Typst sandbox; NestJS+MCP SDK; OAuth consent/PKCE; Tinymist; Git mapping/retry; storage transaction boundary                     | Рішення з файлу 08 | Є результати, exact versions і приклади запуску; ризики SDK/OAuth/sandbox не залишилися припущеннями    |
| P1 — основа               | NestJS strict, config validation, TypeORM migrations, PostgreSQL, logs/error format, health, CI, sessions, register/login/logout, verify/reset email, CSRF | P0                 | Чисте середовище піднімається за інструкцією; auth lifecycle працює через test mailbox                  |
| P2 — домен                | Project, stable file IDs, blobs, accepted revisions, context text, entrypoint, atomic changes, outbox, ownership, concurrency/idempotency                  | P1                 | Два конкурентні saves не втрачають текст; multi-file revision атомарна; між користувачами немає доступу |
| P3 — compile/history      | BullMQ, CompileJob, runner, artifacts/diagnostics, fingerprints; bare Git repos, writer/reconciler, history/diff/restore                                   | P2                 | Багатофайловий Typst→PDF; старий job не стає поточним; restart не губить jobs/Git mapping               |
| P4 — review               | Proposals/candidates, validation, multi-file diff, accept/reject, stale/rebase, явне прийняття compile failure                                             | P3                 | ШІ-правки не змінюють currentRevision до web acceptance; повтор accept дає ту саму ревізію              |
| P5 — зовнішні клієнти     | MCP read/search/propose/compile/resources, PAT, OAuth provider adapter/discovery/PKCE/consent, scopes/project grants/revocation                            | P4; spike уже у P0 | Повний сценарій у реальному MCP-клієнті; revoked credential не працює; MCP не приймає власну правку     |
| P6 — контекст/annotations | Material revisions, PDF/text/CSV/XLSX extraction, search chunks/provenance; annotation anchors/status/reanchor; MCP tools для них                          | P2, P4, P5         | Заміна матеріалу версійна; матеріал не потрапляє у PDF автоматично; rename/restore не губить коментар   |
| P7 — templates/transfer   | System fixtures, власні TemplateVersion, shares/revocation/copy; ZIP import/export і профілі manifest                                                      | P2, P3, P6         | Незалежна копія шаблону; чужий share не відкриває оригінал; ZIP round trip і негативні архіви           |
| P8 — editor/backup        | Tinymist sessions/proxy, diagnostics/completion/format/definitions, outline, quick preview; GitHub App і односторонній backup                              | P3, P5, P6         | Редакторні сценарії у фронтенді; snapshot backup перевірений; remote conflict не перезаписаний          |
| P9 — release              | Повна інтеграція, isolation/load/failure tests, retention/GC, docs, deploy, backups/restore drill, MCP client matrix                                       | P1–P8              | F01–F19/N01–N06 закриті доказами й сценаріями демонстрації                                              |

P0 не є прототипом усієї системи: кожен spike перевіряє конкретну невизначеність і закінчується коротким ADR. Його демонстраційний код не переноситься без перегляду до production.

## 3. Перший наскрізний сценарій

Після P5 має працювати: реєстрація → підтвердження email → порожній/системний шаблон → редагування → PDF → підключення MCP → пропозиція ШІ → diff/помилки або PDF → прийняття/відхилення → нова Git-версія. Це перша цілісна демонстрація, але ще не завершення всього погодженого проєкту.

Прямий MCP write не використовується як тимчасова «готова функція», оскільки погоджено обов'язкове підтвердження.

## 4. Координація з фронтендом

- На P1 погодити auth/cookie/CSRF й формат помилок.
- На P2 видати OpenAPI: tree, revision, atomic save/conflict. Frontend зберігає local draft при conflict.
- На P3 погодити CompileJob, diagnostics positions, artifactAvailable/isCurrent та SSE reconnect.
- На P4 погодити review екран і окрему дію прийняття помилкового Typst.
- На P5 передати MCP connection instructions, consent і connected clients screens.
- На P6–P8 інтегрувати матеріали, annotations/outline, template copy/share, import/export, backup та LSP.

Для кожного контракту додати реальні fixtures позитивної відповіді, validation error, denied access і conflict. Frontend не повинен чекати реалізації всіх модулів, щоб почати роботу.

## 5. Стратегія тестування

Основна модель — сіра скриня, як у вихідних вимогах: перевірки через API/MCP з контрольованими даними та знанням стану БД/черги. Unit tests покривають policy, state transitions, paths, hashes і anchors. Integration tests використовують справжній PostgreSQL; critical flows також Redis, Git і Typst. Mock-only test не доводить придатності компілятора чи OAuth.

| ID тестів | Що перевіряємо                                                                                                                 | Вимоги             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| T01       | Register/verify/login/logout/reset, expiry/reuse challenge, session revocation, CSRF                                           | F01, N04           |
| T02       | Два користувачі, усі вкладені IDs, artifacts, LSP, SSE, shares, jobs, proposals                                                | F02, F06, F19, N04 |
| T03       | Save/reopen, атомарний batch, invalid paths/entrypoint, lost response/retry, concurrent base revision                          | F02, F08, N01, N05 |
| T04       | Успішний multi-file compile, syntax error, timeout/OOM/output limit, missing package, Ukrainian fonts                          | F05, F08, N02, N04 |
| T05       | Зміна тексту під час compile, завершення jobs у зворотному порядку, artifact expiry, unsaved draft                             | F05, N03           |
| T06       | Proposal create/update/validate/accept/reject, stale base, changed candidate, repeated accept, compile-failure acknowledgement | F10, N01, N02      |
| T07       | PAT/OAuth read-only scopes, project allowlist, revoked/expired token, неправильний audience/redirect/PKCE, refresh reuse       | F06, F07, F19, N04 |
| T08       | Реальний MCP read→proposal→compile→resource, client matrix, business errors vs protocol errors                                 | F06, F19           |
| T09       | Git history/diff/restore, crash між Git ref і mapping, відсутній parent mapping, повтор writer                                 | F09, N05           |
| T10       | Матеріали version/replace, PDF без text layer, XLSX без execution, extraction limits, context поза compile root                | F03, F13, N04      |
| T11       | Annotation rename/delete/restore/reanchor/ambiguous quote, ШІ annotation через review                                          | F12, N01           |
| T12       | Template copy independence, scope share, explicit context inclusion, share revocation, original inaccessible                   | F04, F14, F15      |
| T13       | ZIP round trip, manifest entrypoint, traversal/absolute/symlink/bomb/duplicates, failure atomicity                             | F17, N04           |
| T14       | Tinymist completion/format/diagnostics/definition, source vs compiled outline, UTF-16 non-ASCII, stale documentVersion         | F11, F16           |
| T15       | Backup success/retry, remote divergence, revoked GitHub App, exclude secrets, one-way behavior                                 | F18, N05           |
| T16       | Kill worker, Redis outage, storage failure, stale lease result, delete project під час job, GC references                      | N05, N06           |
| T17       | Production smoke, TLS, email URLs, OAuth public resource, restore drill на чистому середовищі                                  | N06                |

Для дефектів зберігати умови, кроки, фактичний/очікуваний результат і request/job IDs. Матрицю F/N → T підтримувати разом зі зміною вимог.

## 6. Вимірювані цілі

Початкові цілі для узгодженого тестового host, не поточні результати:

- CRUD/read/save metadata p95 < 500 ms при 10 одночасних активних користувачах, без мережевого upload time.
- Queue acceptance p95 < 500 ms, без очікування завершення Typst.
- Типовий fixture документа 20 сторінок компілюється до 5 секунд без queue wait; cold/warm вимірюються окремо.
- Під час двох компіляцій CRUD залишається доступним і вкладається в погоджену ціль.
- Повна доставка SSE не є умовою цілісності: після reconnect GET state відновлює правильний результат.

Після P0/P3 записати host specs, corpus, розміри, версії та фактичні показники. Якщо цілі не досягаються, спочатку зменшити concurrency/визначити вузьке місце; не додавати кеш або мікросервіси без вимірювання.

## 7. Definition of Done задачі

Реалізована функція має migration за потреби, DTO/schema, перевірку ownership/scopes, визначені success/error/conflict states, meaningful tests, актуальний OpenAPI/MCP schema та коротку інструкцію перевірки. Зовнішні інтеграції мають failure/retry behavior і не розкривають secrets у logs.

## 8. Фінальна демонстрація

1. Створити два облікові записи; підтвердити приватність проєктів.
2. Створити багатофайловий документ із системного шаблону, додати ресурс, контекст і PDF/таблицю як матеріал.
3. Відкрити редактор, отримати outline, completion і PDF; показати Typst error без втрати тексту.
4. Підключити зовнішній MCP-клієнт через OAuth, прочитати revision і створити multi-file proposal.
5. Показати незмінність основної версії до accept, diff/PDF, reject та окремий accept із попередженням помилки.
6. Спричинити stale proposal ручною правкою й показати конфлікт.
7. Переглянути Git history та відновити стан як нову версію; перевірити annotations.
8. Створити власний шаблон, поширити, скопіювати іншим користувачем і відкликати посилання.
9. Export/import round trip, GitHub backup, відновлення після worker failure, відкликання OAuth.
10. Надати протокол успішного restore drill серверної резервної копії.

Без критеріїв P9 та всієї матриці повна поставка не позначається завершеною, навіть якщо рання демонстрація працює.

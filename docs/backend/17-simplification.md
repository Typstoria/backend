# Спрощення реалізації

Зміни усувають окремий message transport, одноразові ресурсні references і зайві протоколи допоміжних дій. Атомарність документів, ownership, ревізії, idempotency доменних mutations, sandbox і worker fencing збережено.

## Runtime

- PostgreSQL jobs/mappings є durable чергою. Redis, BullMQ та outbox більше не потрібні; старий outbox видаляється міграцією.
- Compile/history polling має окремі мінімальні Nest graphs і не створює HTTP/auth/mail providers. Workers і migration CLI не вимагають Mailjet credentials.
- Ready Git repos не скануються постійно. Відновлення storage/mappings виконується через `npm run history:rebuild -- PROJECT_ID`.
- Offline OpenAPI сканує той самий ApiModule без runtime config/DB та без підстановки credentials.
- Порожні feature modules та невикористані repository registrations прибрані. Майбутні функції зберігаються в scope; код додається разом із поведінкою.

## Зміни API

| Операція                | Поточна поведінка                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Rename                  | Лише title; last-write-wins, без expectedMetadataVersion/metadataVersion                        |
| Upload                  | Без Idempotency-Key; кожен запит створює новий reference з дедуплікацією bytes                  |
| Resource attach         | Reference можна повторно використовувати у файлах/revisions того самого project до TTL          |
| Upload status           | available/expired; attachedRevisionId та consumed-стану немає                                   |
| Staging quota           | Одна owner policy: 400 unexpired references / 256 MiB; прикріплені також рахуються до expiry    |
| Compile request         | Без Idempotency-Key, кожен успішний запит створює job                                           |
| Logout під час compile  | Job продовжується; revoked token більше не читає PDF, інша чинна сесія owner може його отримати |
| Save без зміни manifest | Повертає ту саму revision без нового snapshot/audit/Git work; domain replay result записується  |

Create/save/restore надалі вимагають Idempotency-Key. Delete блокує publication та доступ. Командний atomic batch API і bounded multi-file diff збережено: їхня заміна вимагала б додаткової клієнтської логіки без достатнього виграшу зараз.

Reset/verify інвалідує всі старі access tokens через authVersion; масовий UPDATE revokedAt більше не дублює цей ефект. Logout однієї session надалі використовує revokedAt.

## Міграція

Перед оновленням зупинити старі API/workers та зробити backup БД. Застосувати звичайну команду `npm run migration:run` і запустити нову версію процесів.

`SimplifyBackgroundWork1793119200000` зберігає projects, snapshots, revisions, blobs, uploads, queued/running jobs і Git mappings. Видаляє лише outbox та retired replay/session/consume/metadata-version поля. Уже прийняті jobs дочекаються нового worker; expired leases відновляться звичайним шляхом.

Автоматичний down не може відтворити видалені session/key/replay metadata й навмисно відмовляє. Для повернення старої версії потрібний backup. Історичні міграції не переписано.

2026-10-28 міграцію застосовано до основної локальної БД `typstoria`. Перед застосуванням створено backup `.local/backups/pre-simplification-2026-10-28T14-26-44.435Z/database.dump`; архів відновлено в окремій тимчасовій БД і звірено кількість записів у всіх 16 таблицях. Після міграції кількість записів у збережених таблицях не змінилася, схема відповідає TypeORM entities.

API та compile/history workers запущено як тимчасові користувацькі systemd services: `typstoria-api`, `typstoria-compile-worker`, `typstoria-history-worker`. Обидва health endpoints повернули HTTP 200; усі три Git mappings мають статус ready. Перевірка стану: `systemctl --user status typstoria-api typstoria-compile-worker typstoria-history-worker`. Перед ручним запуском через npm ці services слід зупинити командою `systemctl --user stop typstoria-api typstoria-compile-worker typstoria-history-worker`. Автозапуск після перезавантаження ОС не налаштований.

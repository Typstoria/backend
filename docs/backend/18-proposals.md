# Пропозиції змін і review (P4)

Пропозиція зберігає зміни окремо від основного документа. Create/update/rebase, diff, candidate preview, validation і reject не змінюють currentRevisionId. Лише accept власника через вебсесію може створити прийняту ревізію та Git mapping. MCP transport і credentials додаються на P5; application service вже відхиляє MCP accept/reject.

## Модель

- `proposals`: проєкт, автор/канал, поточна version, draft/accepted/rejected, acceptedRevisionId, expiresAt. Expired обчислюється з TTL, окремий cleanup worker не потрібний.
- `proposal_candidates`: незмінний snapshot кожної version, baseRevisionId, summary та повний operations. Нові файли мають стабільні IDs ще до прийняття, але недоступні через accepted-document endpoints.
- `proposal_validations`: посилання на точну candidate version/snapshot і, за потреби, compileJobId. Результат обчислюється з compile job; дубльованого persisted validation status немає.
- `compile_jobs`: для звичайної компіляції revisionId заповнений, proposalId/candidateVersion порожні. Для preview навпаки. Check constraint і composite candidate FK захищають тип цілі. Обидва види використовують той самий polling, owner quotas, sandbox, leases/fencing і приватні PDF.

До 50 активних пропозицій на проєкт, до 100 версій кожної, строк життя 7 днів. Candidate files/context підпорядковуються звичайним лімітам snapshots; JSON body обмежений 8 MiB.

## REST

Усі маршрути нижче мають prefix `/api/projects/:projectId/proposals`; потрібна чинна вебавторизація власника.

| Метод і суфікс                       | Призначення                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| POST `/`                             | Створити candidate із baseRevisionId, summary? та operations, як у /changes                             |
| GET `/`                              | Cursor pagination: limit 1–100, cursor — proposal ID, новіші першими                                    |
| GET `/:id`                           | Поточна version/hash/base, status, isStale, latestValidationId та acceptedRevisionId                    |
| PATCH `/:id`                         | expectedProposalVersion, summary?, повний operations; новий candidate на тій самій базі                 |
| POST `/:id/rebase`                   | expectedProposalVersion, актуальна baseRevisionId, summary?, повний operations; без автоматичного merge |
| GET `/:id/candidate`                 | Tree, контекст, mainFileId та вихідний operations; candidateVersion? для історичного кандидата          |
| GET `/:id/files/:fileId`             | Текст candidate файла; candidateVersion?                                                                |
| GET `/:id/files/:fileId/download`    | Приватне скачування текстового або binary файла; candidateVersion?                                      |
| GET `/:id/diff`                      | Зміни від базової accepted revision до candidate; candidateVersion?                                     |
| POST `/:id/validate`                 | expectedProposalVersion; повертає validation ID і compileJobId або not_required; HTTP 202               |
| GET `/:id/validations/:validationId` | Статус перевірки саме цієї candidate version та diagnostics                                             |
| POST `/:id/accept`                   | Точний base/version/hash/validation; Idempotency-Key обов’язковий; HTTP 201                             |
| POST `/:id/reject`                   | expectedProposalVersion; HTTP 200; повтор тієї самої відхиленої версії безпечний                        |

PATCH замінює operations повністю, а не дописує операції до попереднього candidate. GET candidate повертає початкові operations для наступного редагування. Нові version не змінюють старі snapshots і не перевикористовують їхню validation. Перевірка/прийняття frozen candidate не потребує чинного staging upload: ресурс уже збережений у snapshot. Побудова нового candidate з uploadId надалі перевіряє звичайний upload TTL.

## Validation і прийняття

Структура перевіряється під час побудови candidate: paths, file IDs, quotas, supported resources, наявність text .typ entrypoint. Невалідний candidate не записується. Validation створює job лише при зміні files/entrypoint; context-only та no-op повертають not_required без Typst.

| Validation status | Значення / accept                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| not_required      | Inputs компілятора не змінилися; можна прийняти                                                |
| queued/running    | Дочекатися завершення; прийняття заборонене                                                    |
| succeeded         | Можна прийняти; PDF через `/api/projects/:p/compilations/:job/pdf`                             |
| compile_failed    | Фактичний TYPST_ERROR; можна прийняти лише з acknowledgeCompileFailure=true                    |
| validation_failed | Infrastructure, timeout, output/resource limit або cancellation; прапорець не обходить помилку |

Перед accept клієнт передає:

```json
{
  "baseRevisionId": 11,
  "expectedProposalVersion": 1,
  "validationId": 4,
  "candidateManifestHash": "значення candidateManifestHash із переглянутої пропозиції",
  "acknowledgeCompileFailure": false
}
```

Числові ID та hash беруться з реальних відповідей. У заголовку потрібний новий Idempotency-Key для нової дії. Перевіряються власність, channel=web, чинна draft/version, base=current, точний hash та validation того самого candidate. Ack не обходить жодну із цих перевірок. Транзакція атомарно створює revision за потреби, оновлює project/proposal, audit, idempotency та Git mapping. No-op приймається з поточним revisionId без зайвого content commit. Повтор того самого accept key/payload повертає той самий результат, навіть якщо основний документ уже змінився після першого прийняття.

Stale proposal залишається доступною для перегляду, але accept повертає REVISION_CONFLICT. Клієнт читає актуальний /state, узгоджує повний operations і виконує explicit rebase. Старий validation ID після rebase не підходить. Два незалежні proposals з однаковою базою не можуть мовчки перезаписати один одного.

Завершення preview повторно перевіряє active project, draft/version і TTL. Результат старого candidate не публікується після update/rebase/reject/expiry. Candidate PDF ніколи не позначається isCurrent=true.

## Перевірка вручну

1. GET `/api/projects/:p/state`; записати revision.id та mainFileId.
2. POST proposal з updateText; переконатися, що звичайний GET файла та /state ще показують старий документ.
3. GET candidate і diff; перевірити всі запропоновані зміни.
4. POST validate з expectedProposalVersion; опитувати GET validation. За наявності compileJobId завантажити preview PDF звичайним compile endpoint.
5. POST accept із точним hash/validation та Idempotency-Key; перевірити нову revision, текст і pending/ready Git mapping.
6. Повторити accept із тим самим key/body — revisionId не зміниться.
7. Окремо перевірити reject, stale після ручного save, explicit rebase та Typst error з/без явного acknowledgement.

Інтеграційні перевірки використовують PostgreSQL, реальне приватне blob storage і compiler stub для контрольованих failures/concurrency. За TEST_TYPST_BINARY_PATH також виконується справжній multi-file Typst candidate із PNG у Linux sandbox. Міграція перевіряється на legacy accepted job, reversible empty schema і populated-proposal rollback guard.

## Локальне застосування

2026-10-28 міграцію `AddProposals1793205600000` застосовано до локальної БД `typstoria`. Перед цим створено `.local/backups/pre-proposals-2026-10-28T16-08-01.710Z/database.dump` і перевірено відновлення в окремій тимчасовій БД. Кількість записів у всіх наявних таблицях збережено; TypeORM schema diff порожній. API та compile/history workers оновлено; live/ready повернули HTTP 200, live OpenAPI містить 13 proposal operations, запит без авторизації відхилено з HTTP 401. Перевірки коду: 114 unit/HTTP tests та 128 integration tests, включно зі справжнім candidate Typst→PDF із PNG.

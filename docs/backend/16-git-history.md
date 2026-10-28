# Git history, diff і restore

History API читає PostgreSQL і не потребує запущеного Git worker. Усі endpoints перевіряють підтвердженого власника та project binding; чужі/видалені IDs дають 404. Відповіді приватні, `no-store`.

## Контракти

- `GET /projects/:id/revisions?limit=20&cursor=…`: newest-first за number, до 100; cursor є номером, route revisionId — ID.
- `GET /revisions/:revisionId`: revision metadata, author/channel, summary, isCurrent, historySyncStatus, commitSha/historyErrorCode.
- `GET /revisions/:revisionId/diff?against=…`: порівняння immutable snapshots за сталими file IDs; added/deleted/renamed/modified, before/after metadata, bounded text patches, context і entrypoint.
- `POST /restore`: `{targetRevisionId, expectedCurrentRevisionId, summary?}` та `Idempotency-Key` створюють нову accepted revision з вибраним immutable snapshot.
- `POST /history/retry`: скидає failed mappings у pending, записує audit і повертає 202 `{projectId, resetCount}`.

Restore не робить Git reset, не копіює bytes і не змінює title. Current pointer/revision/mapping/audit/idempotency записуються атомарно. Replay успішного запиту передує stale check; конфлікт бази — 409 `REVISION_CONFLICT`. Неправильний Typst можна відновити. Annotation/material behavior буде додано разом із відповідними функціями.

Diff: binary — metadata/hash без patch; text до 128 KiB на сторону; до 20 patches включно з context, 256 KiB output, 300 ms budget із per-patch timeout/edit limit. Omitted reason відрізняє binary/size/budget/computation. Незмінені bytes та rename-only не читають storage. Ці межі збережено для bounded HTTP роботи.

## Звичайний worker

PostgreSQL mappings — єдине джерело pending Git роботи. Окремий процес вибирає до двох projects із due mappings; outbox/BullMQ/Redis відсутні.

```bash
npm run worker:history:dev
# Зі збірки: npm run worker:history
```

Session advisory lock серіалізує project між процесами без відкритої DB transaction під час blob/Git I/O. Revision записуються послідовно після ready parent. Lease/attempt fencing захищає publication; timeout Git write — 60 секунд, subprocess — 10 секунд, output до 256 KiB. До п’яти retries з backoff; failed parent блокує descendants, але не прийняті saves.

Bare repo: `GIT_STORAGE_PATH/<owner>/<project>.git`. Git plumbing використовує hash-object/mktree/commit-tree, canonical manifest та stable author/timestamp, тому повтор після crash між ref і DB отримує той самий SHA. CAS ref transaction не перезаписує невідомий head; divergence дає `GIT_DIVERGED`. Приватні paths і stderr не повертаються.

Hooks, filters, inherited Git configs/environment, remotes і shell не використовуються. Files мають mode 100644; reserved paths не дозволяються. Logout автора не скасовує запис уже прийнятої revision. Delete блокує publication.

## Явний repair

Worker **не перевіряє всі ready repositories у фоні**. Після втрати repo або mappings оператор запускає:

```bash
npm run history:rebuild -- PROJECT_ID
```

Rebuild під тим самим project lock відновлює відсутні mappings, скидає attempts/leases у pending і запускає прохід writer. Відомі SHA зберігаються та перевіряються. До 100 revisions обробляються за прохід; решту підбере звичайний worker. Сторонній head не видаляється force reset. Пошкоджені Git objects потребують operator diagnosis, а не прихованого переписування.

Налаштування: `GIT_STORAGE_PATH` (default `.local/history`) та `GIT_BINARY_PATH` (default `/usr/bin/git`). Repo storage має бути приватним і постійним. Graceful shutdown чекає поточну bounded роботу перед закриттям БД.

`npm run test:integration` перевіряє справжні PostgreSQL/Git: polling без Redis, deterministic commits, binary bytes, retries/fencing, crash recovery, explicit rebuild, divergence, hooks/config isolation, restore/ownership та concurrency.

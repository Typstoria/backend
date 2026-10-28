# Ресурси документа

`POST /api/projects/:projectId/uploads` приймає multipart із рівно одним полем `file`, без інших полів. Підтримуються PNG/JPEG/GIF/WebP/PDF/TTF/OTF/WOFF/WOFF2 до 10 MiB. Формат визначається за bytes; filename/extension і MIME перевіряються. Потрібен Bearer-токен підтвердженого власника. `Idempotency-Key` не потрібний.

Upload зберігає bytes і повертає `uploadId`, filename, MIME, hash, size, `expiresAt` та `status=available|expired`. Він не змінює ревізію. Повтор POST створює новий upload reference; однакові bytes дедуплікуються в межах owner. Upload не прив’язаний до login-сесії.

```json
{
  "baseRevisionId": 1,
  "operations": [
    { "type": "attachFile", "uploadId": 1, "path": "assets/logo.png" },
    { "type": "updateText", "fileId": 1, "content": "#image(\"assets/logo.png\")" }
  ]
}
```

Прикріплення виконується через атомарний `/changes`, для якого `Idempotency-Key` зберігається. `replaceFile` змінює bytes, зберігаючи file ID. Якщо змінюється формат, треба також перейменувати кінцевий path. Головний файл має залишитися текстовим `.typ`.

Upload доступний протягом 24 годин і **може використовуватися повторно** в кількох файлах або saves того самого проєкту. `attachedRevisionId` і consumed-стану немає. Після expiry нове attach/replace дає 409 `UPLOAD_EXPIRED`; повтор уже успішного save повертає збережений результат до перевірки expiry.

`GET /uploads/:uploadId` показує поточний статус. Власність і project binding перевіряються для всіх вкладених IDs. Snapshot references зберігають bytes після expiry upload; старі ревізії залишаються доступними.

Одна staging policy на owner: до 400 unexpired upload references і 256 MiB їхніх сумарних bytes. Прикріплені references також рахуються до expiry. Квота спільна для проєктів owner, перевіряється атомарно під owner advisory lock; перевищення — 429 `UPLOAD_QUOTA_EXCEEDED`. Окремих project staging quotas немає. Кінцевий snapshot має власні межі 500 files / 64 MiB.

`GET /files/:fileId/download?revisionId=…` віддає bytes поточної або вибраної прийнятої ревізії як приватний attachment. Авторизація обов’язкова; storage/blob IDs не повертаються. Expiry reference не видаляє прикріплений файл. Фізичний GC ще не реалізований і повинен перевіряти всі snapshot/artifact references.

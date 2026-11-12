# Налаштування облікового запису

Реалізовано редагування імені, зміну поточного пароля та видалення акаунта через одноразове підтвердження поштою. Email і Google identity не змінюються. Налаштування Google Cloud не потрібні.

## API

Усі шляхи мають prefix `/api`. Відповіді приватні, `Cache-Control: no-store`.

| Метод і шлях                          | Контракт                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET `/auth/me`                        | Bearer підтвердженого користувача; AccountDto з `id`, `name`, `email`, `emailVerified`, `createdAt`, `hasPassword` |
| PATCH `/auth/me`                      | Bearer; `{name: string}`; повертає AccountDto                                                                      |
| POST `/auth/change-password`          | Bearer; `{currentPassword, newPassword}`; 204, після успіху потрібен новий login                                   |
| POST `/auth/request-account-deletion` | Bearer; без body; 202 generic message; лише надсилає лист                                                          |
| POST `/auth/delete-account`           | Public; `{token}` з листа; 204 після явного підтвердження                                                          |

Ім’я — nullable display name, не login/унікальний username. String trim, 1–80 Unicode code points без керівних символів; null і порожні значення заборонені. Наявні акаунти можуть мати null до першого встановлення імені, але видалити збережене ім’я через API не можна. Порожній об’єкт, порожній string та зайві поля відхиляються. Ім’я також входить у UserDto для login/Google; `hasPassword` є тільки в AccountDto й не розкриває provider identities чи hashes.

Current password — 1–128, new password — 6–128 символів, без trim/додаткових вимог. Неправильний current password повертає 400 `CURRENT_PASSWORD_INVALID`, не 401; чинний сеанс залишається. Якщо пароль не встановлений — 403 `PASSWORD_NOT_SET`; endpoint не створює пароль для passwordless акаунта. UI приховує цю дію за `hasPassword=false`.

## Конкурентність та сеанси

Account service повторно читає поточні user/session під user row lock: authVersion, revokedAt, expiry. Це блокує mutation із credential, який відкликано після HTTP guard. Читання/запис імені не замінюють passwordHash або Google subject.

Зміна пароля перевіряє поточний hash під тим самим lock, записує новий і збільшує authVersion. Всі попередні access tokens, включно з поточним, стають недійсними. Усі непогашені verify/reset/delete challenges погашаються, щоб старий reset/deletion link не скасував нову підтверджену дію. Password hashing не створює новий session/token.

## Видалення

Запит доступний лише підтвердженому власнику; одержувач береться з поточної user record, не з body. Cooldown — 5 хвилин окремо для delete kind. Token — криптографічний random secret формату наявних identity challenges; у БД лише hash. TTL використовує `AUTH_RESET_TTL_SECONDS` (типово 15 хвилин). Новий запит після cooldown погашає попередній link. Rate limits для change/request/delete — 5 запитів за хвилину на HTTP tracker.

Лист містить `/auth/delete-account#token=…`, попередження про всі проєкти та необхідність окремого підтвердження. GET, email preview/scanner або запит листа нічого не видаляють. Token — достатнє одноразове підтвердження володіння поштою, тому POST підтвердження доступний без активної сесії й працює для passwordless акаунтів. Приватні дані в URL query не передаються. Delivery error не розкриває provider payload і не видаляє даних; 202 не гарантує доставку.

Фінальний POST перевіряє purpose, expiry та consumedAt під user row lock і видаляє user в одній транзакції. FKs каскадно видаляють sessions/challenges та власні projects, snapshots, revisions, mappings/jobs, references й audit. Інші власники не зачіпаються; усі старі токени й доступ до файлів/PDF припиняються. Повторний, прострочений чи неправильного purpose token — 400 `INVALID_OR_EXPIRED_TOKEN`.

Immutable bytes, Git repos, тимчасові artifacts та резервні копії фізично не чистяться в HTTP transaction: вони стають недоступними через API; фізична утилізація потребує окремої GC/retention policy. Endpoint не обіцяє негайного стирання всіх фізичних копій. Worker publication уже перевіряє існування/активність project.

Verify/reset також погашають pending delete challenges. Звичайний logout сам по собі не скасовує вже надісланий link: підтвердження працює через пошту.

## Міграція і перевірки

`AddAccountSettings1794498000000` додає nullable `users.name` без зміни існуючих email/password/Google IDs, а також enum value `delete_account`. Enum відтворюється зі збереженням existing challenge values, щоб працювати у загальній migration transaction. Перед застосуванням зупинити API/workers і зробити backup; команда — `npm run migration:run`. Down прибирає нові deletion challenges і колонку name, але не змінює акаунти чи паролі.

PostgreSQL integration tests перевіряють response/validation/ownership, заборону очищення імені, passwordless policy, wrong-password без revoke, mass revocation, старі reset/delete links, expired/wrong-purpose/replayed tokens, delete race, каскад owned data й ізоляцію другого власника. Mailer підмінений: зовнішні листи не надсилаються. Offline OpenAPI перевіряє нові auth/response contracts.

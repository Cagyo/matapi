# Task 4 — Localized settings and serialized Telegram menus

## Delivered

- Registered users can open `/settings`, select fixed `settings:locale:en`,
  `settings:locale:ru`, or `settings:locale:uk` callbacks, and receive the
  confirmation and refreshed dashboard from the newly selected catalog.
- Locale persistence happens before the callback response and dashboard render;
  a per-user command-menu update is queued only afterwards.
- The dashboard exposes language controls to every registered user and keeps
  auto-clean threshold and cleanup controls admin-only behind the existing
  callback guard.
- Normal `/menu` is catalog-backed, includes a user-accessible Settings entry,
  and keeps all other admin actions guarded in the handler.
- `BotCommandsMenuService` loads each user at job execution time, serializes
  jobs by Telegram ID, applies the user's current locale and role to chat
  command scopes, retries API failures after 1/5/30 seconds, and clears the
  queue after the final attempt. Startup retains English for `all_private_chats`
  and synchronizes every stored recipient with its own locale.
- Role-changing and registration handlers now call the current-user menu API
  without passing a stale role snapshot.

## TDD evidence

Focused RED run (before implementation) failed as expected because settings
was English/admin-only and menu updates neither reloaded users nor retried:

```text
yarn test test/telegram/interfaces/settings.handler.test.ts test/telegram/application/bot-commands-menu.service.test.ts
```

Focused verification after implementation:

```text
yarn test test/telegram/interfaces/settings.handler.test.ts test/telegram/interfaces/menu.handler.test.ts test/telegram/application/bot-commands-menu.service.test.ts test/telegram/interfaces/claim-admin.handler.test.ts test/telegram/interfaces/promote.handler.test.ts test/telegram/interfaces/demote.handler.test.ts
```

Result: 6 files passed, 23 tests passed.

`git diff --check` also passed. `yarn build` is currently blocked by unrelated
in-progress CSV localization changes: the English catalog has CSV keys not yet
present in the Russian and Ukrainian catalogs.

# Per-User Telegram Locales Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let every registered Telegram user persist English, Russian, or Ukrainian and receive all newly generated bot copy in that language.

**Architecture:** Store a validated locale on the Telegram user, attach a resolved catalog to a typed grammY context before authorization guards, and render fan-out messages per recipient. The events context owns a rendering port and normalized notification facts; a Telegram infrastructure adapter renders those facts through immutable locale catalogs.

**Tech Stack:** TypeScript 5.7, NestJS 10, grammY 1.34, Drizzle ORM 0.38 with SQLite, Vitest 2.

## Global Constraints

- Support exactly en, ru, and uk; existing and new users default to en.
- All bot copy, keyboards, callback alerts, command descriptions, captions, and generated file names come from a locale catalog.
- Callback data, sensor identifiers, user-entered names, and raw measurements remain language-neutral.
- Pre-registration feedback, mock broadcasts, and irrecoverable historic raw values are English by the approved compatibility exception.
- New notification/log writes carry codes and raw facts, not English display prose.
- Ports use Symbol tokens and stay in their owning context; do not add a global Nest module.
- Use Logger, never console; never log secrets or chat IDs.
- Menu synchronization is per-user, serial, and retries at most three times.
- Run yarn build and yarn test before completion.

---

### Task 1: Add the locale value object and user persistence

**Files:**
- Create: src/telegram/domain/locale.ts
- Modify: src/database/schema.ts
- Modify: src/telegram/domain/user.entity.ts
- Modify: src/telegram/domain/ports/user-repository.port.ts
- Modify: src/telegram/infrastructure/drizzle-user.repository.ts
- Modify: src/telegram/infrastructure/in-memory-user.repository.ts
- Modify: src/telegram/application/register-user.use-case.ts
- Modify: src/telegram/application/claim-admin.use-case.ts
- Test: test/telegram/domain/locale.test.ts
- Test: test/telegram/infrastructure/drizzle-user.repository.test.ts
- Test: test/telegram/application/register-user.use-case.test.ts

**Interfaces:**
- Produces Locale, DEFAULT_LOCALE, isLocale(value), and normalizeLocale(value).
- Adds locale to User and NewUser.
- Adds setLocale(telegramId, locale): Promise<User> to UserRepositoryPort.

- [ ] **Step 1: Write the failing locale tests**

~~~ts
expect(isLocale('uk')).toBe(true);
expect(isLocale('de')).toBe(false);
expect(normalizeLocale(null)).toBe('en');
expect(normalizeLocale('corrupt')).toBe('en');
~~~

- [ ] **Step 2: Verify the new test fails**

Run: yarn test test/telegram/domain/locale.test.ts

Expected: FAIL because the locale module does not exist.

- [ ] **Step 3: Implement the pure locale module**

~~~ts
export const SUPPORTED_LOCALES = ['en', 'ru', 'uk'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value as Locale);
}

export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
~~~

- [ ] **Step 4: Add failing repository and registration assertions**

Assert that createUser, createAdmin, and claimFirstAdmin return locale en; setLocale changes only the target user; and createAdmin upsert preserves an existing user locale while changing their role/name.

- [ ] **Step 5: Implement schema and repository mapping**

Add a non-null users.locale column with default DEFAULT_LOCALE. Persist NewUser.locale, map database values through normalizeLocale, and implement setLocale with the same missing-user error behavior as setMuted. InMemoryUserRepository defaults stored users to DEFAULT_LOCALE.

- [ ] **Step 6: Set the default in creation use cases**

Pass locale: DEFAULT_LOCALE from RegisterUserUseCase and ClaimAdminUseCase. Do not inspect Telegram profile language or invite data.

- [ ] **Step 7: Generate and test the migration**

Run: yarn db:generate

Expected: Drizzle emits an SQLite migration adding a non-null locale column with English default. Do not hand-edit its SQL or metadata.

Run: yarn test test/telegram/domain/locale.test.ts test/telegram/infrastructure/drizzle-user.repository.test.ts test/telegram/application/register-user.use-case.test.ts

Expected: PASS.

- [ ] **Step 8: Commit**

~~~bash
git add src/database/schema.ts migrations src/telegram/domain/locale.ts src/telegram/domain/user.entity.ts src/telegram/domain/ports/user-repository.port.ts src/telegram/infrastructure/drizzle-user.repository.ts src/telegram/infrastructure/in-memory-user.repository.ts src/telegram/application/register-user.use-case.ts src/telegram/application/claim-admin.use-case.ts test/telegram/domain/locale.test.ts test/telegram/infrastructure/drizzle-user.repository.test.ts test/telegram/application/register-user.use-case.test.ts
git commit -m "feat: persist Telegram user locales"
~~~

### Task 2: Establish complete self-contained catalogs

**Files:**
- Create: src/locales/catalog.ts
- Create: src/locales/ru.ts
- Create: src/locales/uk.ts
- Create: src/locales/index.ts
- Modify: src/locales/en.ts
- Test: test/locales/catalog.test.ts
- Test: test/locales/ru.test.ts
- Test: test/locales/uk.test.ts

**Interfaces:**
- Produces LocaleCatalog, catalogs, and catalogFor(locale).
- Locale inputs used only as types use import type.

- [ ] **Step 1: Write failing registry and output tests**

~~~ts
expect(catalogFor('en')).toBe(en);
expect(catalogFor('invalid')).toBe(en);
expect(catalogFor('ru').commands.find((c) => c.command === 'settings')?.description)
  .not.toBe(en.commands.find((c) => c.command === 'settings')?.description);
expect(catalogFor('uk').status.footer(false, 2, FIXED_NOW))
  .not.toContain('sensors offline');
~~~

For Russian and Ukrainian, assert 1, 2, and 5 variants for every count-bearing formatter: status, camera events, durations, and notification counts.

- [ ] **Step 2: Verify failure**

Run: yarn test test/locales/catalog.test.ts test/locales/ru.test.ts test/locales/uk.test.ts

Expected: FAIL because no registry or Russian/Ukrainian catalogs exist.

- [ ] **Step 3: Define the catalog contract and registry**

~~~ts
import { en } from './en';

export type LocaleCatalog = typeof en;

export const catalogs: Readonly<Record<Locale, LocaleCatalog>> = { en, ru, uk };

export function catalogFor(locale: Locale | unknown): LocaleCatalog {
  return catalogs[normalizeLocale(locale)];
}
~~~

Move all visible fallback words, age strings, state labels, formatting labels, command metadata, and file names into the catalog shape. Keep emoji and raw units only where they are intentionally language-neutral.

- [ ] **Step 4: Translate the complete catalogs**

Copy the full English object shape into ru.ts and uk.ts, translate every value/function output, add language-picker keys, a historical-value wrapper, and generic typed failure labels. Make settings command metadata user scope. No Russian/Ukrainian renderer may import or call en at runtime.

- [ ] **Step 5: Verify catalog coverage**

Run: yarn test test/locales

Expected: PASS. Temporarily removing one nested key must produce a TypeScript failure before restoration.

- [ ] **Step 6: Commit**

~~~bash
git add src/locales test/locales
git commit -m "feat: add Russian and Ukrainian locale catalogs"
~~~

### Task 3: Resolve locale before Telegram guards and handlers

**Files:**
- Create: src/telegram/interfaces/telegram-context.ts
- Create: src/telegram/interfaces/locale.middleware.ts
- Modify: src/telegram/interfaces/telegram-handler.ts
- Modify: src/telegram/interfaces/role.middleware.ts
- Modify: src/telegram/infrastructure/grammy-bot.gateway.ts
- Modify: src/telegram/telegram.module.ts
- Test: test/telegram/interfaces/locale.middleware.test.ts
- Test: test/telegram/interfaces/role.middleware.test.ts

**Interfaces:**
- Produces TelegramContext = Context plus localeState { user, locale, catalog }.
- Produces LocaleMiddleware.resolveRegistered and LocaleMiddleware.resolveOptional.
- Changes TelegramHandler.register to Composer<TelegramContext>.

- [ ] **Step 1: Write failing middleware/guard tests**

~~~ts
await middleware.resolveRegistered(ukUserContext, next);
expect(ukUserContext.localeState?.catalog).toBe(catalogFor('uk'));

await role.adminOnly(ukNonAdminContext, next);
expect(ukNonAdminContext.reply)
  .toHaveBeenCalledWith(catalogFor('uk').common.adminRequired);
~~~

Cover missing ctx.from, unregistered users, and invalid persisted values.

- [ ] **Step 2: Verify failure**

Run: yarn test test/telegram/interfaces/locale.middleware.test.ts test/telegram/interfaces/role.middleware.test.ts

Expected: FAIL because TelegramContext and LocaleMiddleware do not exist.

- [ ] **Step 3: Implement a single registered-user lookup**

LocaleMiddleware loads UserRepositoryPort.findByTelegramId(ctx.from.id), normalizes user.locale, and attaches localeState. RoleMiddleware reads localeState, never queries users again, and never imports en for a reply.

- [ ] **Step 4: Register middleware in correct grammY order**

Create Bot<TelegramContext>. Register private-chat filter, health tracker, then optional locale resolution before calling handler.register. Registered/admin guards execute after resolution. Keep start/claim_admin pre-registration error paths English.

The current grammY documentation confirms custom context properties are added in bot.use middleware and that this middleware must be registered before command and callback listeners.

- [ ] **Step 5: Convert handler callback types**

Replace Composer<Context> and registered callback Context parameters with Composer<TelegramContext> and TelegramContext in every file under src/telegram/interfaces. Leave only intentionally pre-registration helpers without localeState on the base type.

- [ ] **Step 6: Verify type compatibility**

Run: yarn test test/telegram/interfaces/locale.middleware.test.ts test/telegram/interfaces/role.middleware.test.ts

Expected: PASS.

Run: yarn build

Expected: PASS with no Composer generic variance errors.

- [ ] **Step 7: Commit**

~~~bash
git add src/telegram/interfaces src/telegram/infrastructure/grammy-bot.gateway.ts src/telegram/telegram.module.ts test/telegram/interfaces
git commit -m "feat: resolve locale before Telegram handlers"
~~~

### Task 4: Expose localized user settings and synchronize menus safely

**Files:**
- Modify: src/telegram/interfaces/settings.handler.ts
- Modify: src/telegram/interfaces/menu.handler.ts
- Modify: src/telegram/interfaces/config.handler.ts
- Modify: src/telegram/application/bot-commands-menu.service.ts
- Modify: src/telegram/interfaces/start.handler.ts
- Modify: src/telegram/interfaces/claim-admin.handler.ts
- Modify: src/telegram/interfaces/promote.handler.ts
- Modify: src/telegram/interfaces/demote.handler.ts
- Test: test/telegram/interfaces/settings.handler.test.ts
- Test: test/telegram/interfaces/menu.handler.test.ts
- Test: test/telegram/application/bot-commands-menu.service.test.ts

**Interfaces:**
- SettingsHandler consumes UserRepositoryPort and BotCommandsMenuService.
- BotCommandsMenuService.updateUserMenu(telegramId): Promise<void> loads current role and locale itself.

- [ ] **Step 1: Write failing settings tests**

Test that a registered non-admin opens settings, sees only language controls, chooses settings:locale:uk, persists uk, gets Ukrainian callback confirmation, and triggers a menu update. Test invalid locale data and admin-only threshold callbacks separately.

- [ ] **Step 2: Write failing menu race/retry tests**

~~~ts
await Promise.all([
  menu.updateUserMenu(100),
  repo.setLocale(100, 'uk').then(() => menu.updateUserMenu(100)),
]);
expect(lastSetMyCommandsCall()).toEqual(
  catalogFor('uk').commands.filter((command) => command.scope === 'user'),
);
~~~

Use fake timers to prove retries occur after 1 second, 5 seconds, and 30 seconds following a rejected setMyCommands call. Assert startup sync uses each stored locale while all_private_chats stays English.

- [ ] **Step 3: Implement the split dashboard**

Build language buttons from ctx.localeState.catalog with fixed settings:locale:en, settings:locale:ru, and settings:locale:uk data. Persist first, answer/rerender with the new catalog second, and queue menu synchronization third. Render threshold and cleanup controls only for admins; preserve admin guard on settings:set:<threshold>.

- [ ] **Step 4: Implement user menu discoverability**

Add a localized Language/Settings entry to the normal top menu. Replace all visible literals in menu.handler.ts and config.handler.ts with catalog keys. Keep callback data unchanged. The settings command descriptor remains visible to users while admin controls remain in-handler.

- [ ] **Step 5: Serialize menu updates**

Maintain Map<number, Promise<void>>. Each queued job re-loads the user, derives catalogFor(user.locale).commands filtered by role, and calls bot.api.setMyCommands with { scope: { type: 'chat', chat_id } }. Retry failures after 1 second, 5 seconds, and 30 seconds; clear the map entry after the final attempt, and enqueue every stored user during startup sync.

- [ ] **Step 6: Verify**

Run: yarn test test/telegram/interfaces/settings.handler.test.ts test/telegram/interfaces/menu.handler.test.ts test/telegram/application/bot-commands-menu.service.test.ts test/telegram/interfaces/start.handler.test.ts test/telegram/interfaces/claim-admin.handler.test.ts

Expected: PASS.

- [ ] **Step 7: Commit**

~~~bash
git add src/telegram/interfaces/settings.handler.ts src/telegram/interfaces/menu.handler.ts src/telegram/interfaces/config.handler.ts src/telegram/application/bot-commands-menu.service.ts src/telegram/interfaces/start.handler.ts src/telegram/interfaces/claim-admin.handler.ts src/telegram/interfaces/promote.handler.ts src/telegram/interfaces/demote.handler.ts test/telegram/interfaces/settings.handler.test.ts test/telegram/interfaces/menu.handler.test.ts test/telegram/application/bot-commands-menu.service.test.ts
git commit -m "feat: add per-user Telegram language settings"
~~~

### Task 5: Localize commands, keyboards, errors, and active flows

**Files:**
- Modify: src/telegram/interfaces/camera.handler.ts
- Modify: src/telegram/interfaces/clean.handler.ts
- Modify: src/telegram/interfaces/config.handler.ts
- Modify: src/telegram/interfaces/export-config.handler.ts
- Modify: src/telegram/interfaces/feature.handler.ts
- Modify: src/telegram/interfaces/gdrive-auth.handler.ts
- Modify: src/telegram/interfaces/gdrive.handler.ts
- Modify: src/telegram/interfaces/health.handler.ts
- Modify: src/telegram/interfaces/help.handler.ts
- Modify: src/telegram/interfaces/import-config.handler.ts
- Modify: src/telegram/interfaces/invite.handler.ts
- Modify: src/telegram/interfaces/logs.handler.ts
- Modify: src/telegram/interfaces/mute.handler.ts
- Modify: src/telegram/interfaces/ping.handler.ts
- Modify: src/telegram/interfaces/quiet-hours.handler.ts
- Modify: src/telegram/interfaces/restart.handler.ts
- Modify: src/telegram/interfaces/rollback.handler.ts
- Modify: src/telegram/interfaces/status.handler.ts
- Modify: src/telegram/interfaces/system-update.handler.ts
- Modify: src/telegram/interfaces/unmute.handler.ts
- Modify: src/telegram/interfaces/update.handler.ts
- Test: test/telegram/interfaces/*.test.ts

**Interfaces:**
- Each registered command/callback/flow continuation starts with const t = ctx.localeState!.catalog.
- User replies use catalog keys or typed user-input mappings; never Error.message or provider reason.

- [ ] **Step 1: Add failing representative tests**

Add English/Russian/Ukrainian assertions for status, camera dashboard, config keyboard, import failure, and admin-denial replies. Start a configuration/import/camera flow, change the stored locale, then assert the next incoming update produces a prompt in the new locale.

- [ ] **Step 2: Verify failure**

Run: yarn test test/telegram/interfaces/status.handler.test.ts test/telegram/interfaces/camera.handler.test.ts test/telegram/interfaces/config.handler.test.ts test/telegram/interfaces/import-config.handler.test.ts

Expected: FAIL because these handlers render en directly.

- [ ] **Step 3: Convert all active handlers**

Replace direct en access with t, pass t into keyboard/formatter helpers, and localize captions/file names. Resolve t from the current update, not conversation state. Apply the same conversion to every listed handler before moving on.

- [ ] **Step 4: Replace leaked technical messages**

Map typed validation failures to catalog methods. Map parser, transport, provider, and unexpected failures to a generic localized operation failure. Log original reason/message with Logger only.

- [ ] **Step 5: Audit all user-copy sources**

Run: rg -n "from ['\"](?:\\.\\.?/)*.*locales/en['\"]|\\.text\\(['\"][^']|ctx\\.reply\\(['\"][^']" src/telegram src/events src/sensors --glob '*.ts'

Expected: remaining results are catalog definitions, tests, Logger-only text, callback data, approved English compatibility paths, or raw historic values. Move every other result into a catalog.

- [ ] **Step 6: Verify and commit**

Run: yarn test test/telegram/interfaces

Expected: PASS.

~~~bash
git add src/telegram/interfaces test/telegram/interfaces
git commit -m "feat: localize Telegram command interactions"
~~~

### Task 6: Render normalized notifications per recipient

**Files:**
- Create: src/events/application/ports/notification-renderer.port.ts
- Create: src/events/application/notification-renderer.service.ts
- Modify: src/events/domain/ports/recipient.port.ts
- Modify: src/events/application/notification.service.ts
- Modify: src/events/application/event-queue.service.ts
- Modify: src/events/domain/sensor-notification.ts
- Modify: src/events/domain/motion-notification.ts
- Modify: src/sensors/infrastructure/mqtt-sensor.adapter.ts
- Modify: src/sensors/infrastructure/digital-gpio.adapter.ts
- Modify: src/sensors/infrastructure/mock-gpio.adapter.ts
- Modify: src/events/event.module.ts
- Create: src/telegram/infrastructure/telegram-notification-renderer.adapter.ts
- Modify: src/telegram/infrastructure/telegram-recipient-directory.adapter.ts
- Modify: src/telegram/infrastructure/grammy-bot.gateway.ts
- Modify: src/telegram/telegram.module.ts
- Test: test/events/application/notification.service.test.ts
- Test: test/events/application/notification-renderer.service.test.ts
- Test: test/telegram/infrastructure/telegram-notification-renderer.adapter.test.ts

**Interfaces:**
- NotificationRecipient adds locale: NotificationLocale.
- NotificationRendererPort exposes renderSensor(input, locale), renderMotion(input, locale), renderSystemOnline(input, locale), renderRestart(input, locale), and renderAdminAlert(input, locale).
- NotificationRendererService mirrors RecipientDirectoryService with register, clear, and delegate methods.

- [ ] **Step 1: Write failing multilingual fan-out tests**

Create one sensor event with English, Russian, and Ukrainian recipients. Assert distinct text/action labels and identical logs callback data. Add motion-photo captions, quiet-hour suppression, and English mock-broadcast coverage.

- [ ] **Step 2: Verify failure**

Run: yarn test test/events/application/notification.service.test.ts

Expected: FAIL because NotificationRecipient has no locale and NotificationService builds one message before the recipient loop.

- [ ] **Step 3: Define normalized facts and the events-owned port**

~~~ts
export interface NotificationRendererPort {
  renderSensor(input: SensorNotificationView, locale: NotificationLocale): NotificationMessage;
  renderMotion(input: MotionNotificationView, locale: NotificationLocale): string;
  renderSystemOnline(input: SystemOnlineNotice, locale: NotificationLocale): string;
  renderRestart(input: RestartNotice, locale: NotificationLocale): string;
  renderAdminAlert(input: AdminAlertNotice, locale: NotificationLocale): string;
}
export interface SystemOnlineNotice {
  sensorsOnline: number;
  sensorsTotal: number;
  dbRecovery: DbRecovery;
  clockSynchronized: boolean;
  now: Date;
}
export interface RestartNotice {
  reason: 'user_command' | 'ota_update' | 'ota_update_failed' | 'rollback' | 'rollback_failed';
  commit: string | null;
}
export interface AdminAlertNotice {
  kind: CameraAdminAlert;
  detail: string | null;
}
export const NOTIFICATION_RENDERER = Symbol('NOTIFICATION_RENDERER');
~~~

Make events/domain notification files contain only language-neutral input types. Add stable codes for MQTT availability and generated system states; preserve raw values for normal sensor readings.

- [ ] **Step 4: Implement adapter and runtime seam**

TelegramNotificationRendererAdapter calls catalogFor(locale) and returns text/actions without importing a concrete catalog. NotificationRendererService is registered/cleared by GrammyBotGateway like RecipientDirectoryService. Bind the events-owned port to that delegate in EventModule.

- [ ] **Step 5: Render in recipient loops and handle legacy records**

In NotificationService.process and notifyMotion, apply suppression first, render second, and send third for each recipient. Project user.locale in TelegramRecipientDirectoryAdapter. Normalize known old MQTT English values while draining; render unknown historic values through the active catalog historical wrapper without rewriting rows.

- [ ] **Step 6: Verify and commit**

Run: yarn test test/events/application/notification.service.test.ts test/events/application/notification-renderer.service.test.ts test/telegram/infrastructure/telegram-notification-renderer.adapter.test.ts

Expected: PASS with independent recipient text and unchanged queue semantics.

~~~bash
git add src/events src/sensors/infrastructure/mqtt-sensor.adapter.ts src/sensors/infrastructure/digital-gpio.adapter.ts src/sensors/infrastructure/mock-gpio.adapter.ts src/telegram/infrastructure/telegram-notification-renderer.adapter.ts src/telegram/infrastructure/telegram-recipient-directory.adapter.ts src/telegram/infrastructure/grammy-bot.gateway.ts src/telegram/telegram.module.ts test/events test/telegram/infrastructure/telegram-notification-renderer.adapter.test.ts
git commit -m "feat: localize per-recipient notifications"
~~~

### Task 7: Localize direct and boot-time recipient messages

**Files:**
- Modify: src/telegram/application/restart-confirmation.service.ts
- Modify: src/telegram/application/system-online-notifier.service.ts
- Modify: src/telegram/infrastructure/telegram-admin-alert.adapter.ts
- Modify: src/telegram/interfaces/start.handler.ts
- Modify: src/telegram/interfaces/promote.handler.ts
- Modify: src/telegram/interfaces/demote.handler.ts
- Test: test/telegram/application/restart-confirmation.service.test.ts
- Test: test/telegram/application/system-online-notifier.service.test.ts
- Test: test/telegram/infrastructure/telegram-admin-alert.adapter.test.ts

**Interfaces:**
- Background services resolve a catalog/renderer for every recipient before calling existing DirectMessengerPort.send or EventNotifierService.notifyUser.
- DirectMessengerPort stays a transport-only text sender.

- [ ] **Step 1: Write failing mixed-locale tests**

Seed English, Russian, and Ukrainian admins. Assert restart confirmations and camera alerts produce different target text. Assert SystemOnlineNotifier uses notifyUser once per registered recipient instead of one notify broadcast.

- [ ] **Step 2: Verify failure**

Run: yarn test test/telegram/application/restart-confirmation.service.test.ts test/telegram/application/system-online-notifier.service.test.ts test/telegram/infrastructure/telegram-admin-alert.adapter.test.ts

Expected: FAIL because each service constructs one English message before its loop.

- [ ] **Step 3: Render before every target send**

For every target, derive catalogFor(user.locale) or call NotificationRendererPort with normalized facts, then call existing transport. Keep one recipient failure isolated and logged; do not move locale lookup into TelegramDirectMessenger.

- [ ] **Step 4: Verify and commit**

Run: yarn test test/telegram/application/restart-confirmation.service.test.ts test/telegram/application/system-online-notifier.service.test.ts test/telegram/infrastructure/telegram-admin-alert.adapter.test.ts

Expected: PASS.

~~~bash
git add src/telegram/application/restart-confirmation.service.ts src/telegram/application/system-online-notifier.service.ts src/telegram/infrastructure/telegram-admin-alert.adapter.ts src/telegram/interfaces/start.handler.ts src/telegram/interfaces/promote.handler.ts src/telegram/interfaces/demote.handler.ts test/telegram/application/restart-confirmation.service.test.ts test/telegram/application/system-online-notifier.service.test.ts test/telegram/infrastructure/telegram-admin-alert.adapter.test.ts
git commit -m "feat: localize Telegram background messages"
~~~

### Task 8: Document, migrate-test, and verify repository-wide behavior

**Files:**
- Modify: docs/specs/01-database.md
- Modify: docs/specs/06-bot-core.md
- Modify: docs/ports-and-adapters.md
- Test: all locale, database, Telegram, events, and sensor tests above

**Interfaces:**
- Documents users.locale, locale middleware ordering, NotificationRendererPort, English legacy compatibility, and user-accessible settings.

- [ ] **Step 1: Prove migration compatibility in an isolated database**

Create a temporary SQLite file at the old migration level under test/.tmp, run DATABASE_PATH=test/.tmp/pre-locale.db yarn db:migrate against it, load the existing user with DrizzleUserRepository, and assert locale === 'en'. Never operate on data/*.db*.

- [ ] **Step 2: Update project documentation**

Document users.locale and Drizzle generation in specs/01-database.md. Document per-user language choice, guard ordering, English pre-registration behavior, and recipient fan-out in specs/06-bot-core.md. Add the events-owned renderer port and Telegram adapter to ports-and-adapters.md.

- [ ] **Step 3: Run final copy audit**

Run: rg -n "from ['\"](?:\\.\\.?/)*.*locales/en['\"]|\\.text\\(['\"][^']|ctx\\.reply\\(['\"][^']" src --glob '*.ts'

Expected: inspect every result; accept only catalog definitions, tests, Logger-only text, callback data, approved compatibility paths, or historic raw values.

- [ ] **Step 4: Run focused and complete verification**

Run: yarn test test/locales test/telegram test/events test/sensors test/database

Expected: PASS.

Run: yarn build && yarn test

Expected: both commands exit 0.

- [ ] **Step 5: Inspect the final diff and commit docs**

Run: git diff --check && git status --short

Expected: no whitespace errors and no unintended data, env, or migration-meta edits.

~~~bash
git add docs/specs/01-database.md docs/specs/06-bot-core.md docs/ports-and-adapters.md test
git commit -m "docs: document per-user Telegram locales"
~~~

## Plan Self-Review

- Spec coverage: Tasks 1-2 implement validated storage and catalogs; Tasks 3-5 implement middleware, guards, settings, command menus, flows, and all interactive copy; Tasks 6-7 implement normalized events and every direct/background recipient path; Task 8 verifies migration safety, docs, and the complete source inventory.
- Placeholder scan: every task has exact paths, interfaces, failing behavior, implementation direction, commands, and commit scope. Migration filenames are deliberately emitted only by yarn db:generate under the repository rule.
- Type consistency: Locale is persisted on User; NotificationLocale is the events recipient projection; LocaleCatalog owns presentation; NotificationRendererPort is the events-to-localization boundary.

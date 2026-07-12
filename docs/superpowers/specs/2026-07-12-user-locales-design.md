# Per-User Telegram Locales — Design

## Goal

Provide complete English, Russian, and Ukrainian Telegram experiences. Every
registered user chooses a language independently through `/settings`; the
choice persists across restarts and applies to every bot-facing message that
user receives.

New and existing users default to English. The bot does not infer language
from Telegram profile settings.

## Scope

The selected locale applies to interactive command replies, inline-keyboard
labels and callback alerts, command-menu descriptions, media captions, direct
messages, notification text and notification actions, system-online notices,
OTA/restart confirmations, and camera/admin alerts.

Unregistered interactions retain the existing behavior: they are ignored,
except for pre-registration `/start` and first-admin claim feedback, which is
English because no stored user preference exists. Mock/development broadcast
output is likewise English.

## Locale model and storage

- Define the supported `Locale` value union: `en`, `ru`, and `uk`, with
  `DEFAULT_LOCALE = 'en'`.
- Add a non-null `locale` column to the `users` schema, defaulting to `en`.
  Generate the Drizzle migration from `schema.ts`; it must backfill existing
  rows to English before the non-null constraint is relied on.
- Extend `User`, `NewUser`, the user repository port, and both Drizzle and
  in-memory adapters with locale support and `setLocale(telegramId, locale)`.
  Registration and first-admin creation persist the default explicitly.
- Reads defensively normalize a missing or unrecognized persisted value to
  English. Only the three supported values are accepted for writes.

## Catalogs and rendering boundaries

`src/locales/en.ts` remains the canonical catalog contract. Add complete
Russian and Ukrainian catalogs with the same nested key and function shape;
TypeScript verifies that neither can omit a key. A registry maps a valid
`Locale` to its immutable catalog and safely falls back to English.

Each catalog is self-contained: no Russian or Ukrainian renderer may import or
call the English catalog at runtime. Shared helpers receive their catalog or
only language-neutral data. Existing locale-module imports used only for view
types become `import type` imports, preventing runtime cycles between locale,
event, and Telegram modules. Output assertions for each locale supplement the
catalog-shape check.

There is no mutable, process-wide current locale. A handler resolves one
catalog from the requesting registered user at the start of an update. A
background send resolves the recipient's catalog immediately before rendering
that recipient's message.

For registered updates, a locale middleware runs before the registered-user
and role guards. It resolves the user once and attaches the normalized locale
and role to the typed Telegram context. Guards use that context for localized
denials rather than importing English directly. Pre-registration `/start` and
`/claim_admin` paths intentionally bypass this middleware and use English.

Internal events and log records must not contain English display prose that
will later be delivered to a user. Sensor availability, motion, and state
changes carry a stable event code plus raw facts (sensor name, values,
severity, timestamps, and step type). Localized formatters turn those facts
into text only at the per-recipient delivery boundary. Sensor names,
configuration identifiers, raw measurements, and callback-data identifiers
are not translated.

This moves the existing English-only sensor and motion formatting out of the
single shared pre-send message path. A recipient directory exposes each
recipient's locale together with their mute and quiet-hour preferences, while
remaining an events-owned port implemented by the Telegram adapter.

The events-owned recipient port declares its own `NotificationLocale` union
with the three supported values. The Telegram adapter maps a user's locale to
that value; the events context never imports Telegram's user entity or domain
types. Direct-message adapters remain transport-only: callers that know the
recipient render localized text before calling `send`.

### Historic records

Existing queued events and sensor-log rows can contain irrecoverable English
display text. They are immutable historical data, not newly generated bot
copy, so this change does not rewrite them. The implementation normalizes
known queued MQTT availability values to their new event codes when possible;
unrecognized legacy values are presented verbatim inside a localized
"historical value" wrapper. All events and logs written after this release
use codes and raw facts, so every newly generated bot message is localized.
This is the approved compatibility exception to complete localization of
historical raw data.

## Settings and access control

`/settings` is available to every registered user. Its first section is a
language panel showing English, Русский, and Українська, with the selected
option clearly indicated. Locale callback data is language-neutral and
strictly allowlisted, for example `settings:locale:uk`.

The callback identifies the user exclusively from `ctx.from.id`; it cannot
set another user's preference. It persists the selected locale before
confirming the callback and rerendering the dashboard, so the confirmation
and refreshed UI use the new language. Stale language buttons remain safe and
simply select their encoded supported locale.

The existing cleanup-threshold and cleanup controls remain in the same
dashboard but are displayed and handled only for administrators. A registered
non-admin may use the language section but cannot see or invoke administrative
controls. Authorization failures for registered users use their catalog;
unregistered users continue to receive no reply.

The regular `/menu` includes a localized Language/Settings entry for every
registered user, not only the existing administrator system-settings path.
The implementation inventory covers every current hard-coded keyboard and
reply label as well as every direct `en` catalog import; no new user-facing
literal may be introduced outside a catalog.

The `/settings` command descriptor is user scope so it appears in every
registered user's Telegram command menu; admin-only controls are enforced
inside the handler, not by hiding the command itself.

## Menus and delivery flows

After a successful locale update, the bot updates that chat's Telegram command
menu using the selected catalog's command descriptions. A failure to update
Telegram's menu is logged but does not roll back the saved locale; normal
startup synchronization retries it for every registered user. Role changes
continue to select the correct command set while preserving the target user's
locale.

Command-menu synchronization is serialized per Telegram user. Each queued
operation re-reads the user's persisted locale when it starts, so rapid taps
of two language buttons obey last persisted choice and cannot leave an older
locale in Telegram after the newer callback completes.

If Telegram rejects a menu update after its normal transport retry, the
per-user queue retries it up to three times with bounded backoff. Failure is
logged and does not roll back the locale; process restart performs the normal
full synchronization as a final recovery path.

The events application owns a `NotificationRendererPort` whose methods accept
normalized event facts and `NotificationLocale`, returning localized text and
action labels. A Telegram infrastructure adapter implements it using the
catalog registry and is registered at bot bootstrap through the same runtime
seam as the recipient directory. `NotificationService` renders inside each
recipient iteration. System-online notifications follow the same
per-recipient route rather than the current one-text broadcast.

All multi-recipient paths render inside their recipient loop:

- sensor notifications, motion captions, and action buttons;
- promotion/demotion and invite-related direct messages;
- restart, rollback, update, and system-online messages;
- camera daemon, drive, and disk administrative alerts.

Thus a single event can send Russian text to one recipient, Ukrainian text to
another, and English text to a third. Failure to render or deliver for one
recipient neither changes another recipient's locale nor prevents remaining
deliveries. Existing retry and queue behavior remains unchanged.

## Error handling and compatibility

- Unsupported callback values, absent sender data, and repository errors use
  the existing handler error path without leaking a mutable locale state.
- Generic error wrappers and action names are catalog keys. User replies never
  interpolate arbitrary exception messages or English transport/provider
  reasons; technical detail remains in structured server logs.
- Interfaces map typed user-input errors (for example malformed configuration
  fields) to catalog keys. Unexpected parser, provider, and infrastructure
  errors use a generic localized failure, never an `err.reason` or raw error
  message.
- Existing inline keyboards remain routable because their callback data is not
  localized. Rendering them after a language change uses the latest stored
  locale for the sender.
- Database migration follows the project rule: change `schema.ts`, then run
  `yarn db:generate`; never hand-edit migration files.

## Verification

Tests cover:

1. locale validation, English fallback, and complete catalog shape;
2. repository defaults/backfill mapping and locale update behavior;
3. language-panel access for registered users, admin-only settings controls,
   invalid/stale callbacks, and immediate localized rerender;
4. per-user command-menu descriptions after selection and during startup sync;
5. sender-localized interactive errors and target-localized direct messages;
6. a shared event sent to English, Russian, and Ukrainian recipients, proving
   that text, captions, and action labels render separately while suppression
   and retry semantics are preserved.
7. per-user serialized menu synchronization after rapid language selections;
8. recognized and unrecognized legacy event payload behavior;
9. Russian and Ukrainian plural forms for 1, 2–4, and 5+ values in every
   counted catalog message.
10. localized role-guard rejection, proving locale middleware precedes the
    guard, plus English pre-registration feedback;
11. a language change while a configuration, import, or camera flow is open,
    proving every continuation resolves the latest locale per update;
12. bounded command-menu retry after a Telegram API failure and `/settings`
    visibility in a non-admin command menu.

## Non-goals

- Automatic language detection from Telegram.
- Translating sensor names, user-supplied names, values, identifiers, or
  callback data.
- Per-user timezone or date-format preferences; existing configured timezone
  and numeric date formatting remain unchanged.
- Supporting locales beyond English, Russian, and Ukrainian in this change.

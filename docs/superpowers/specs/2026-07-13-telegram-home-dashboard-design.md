# Telegram Home Dashboard Design

**Date:** 2026-07-13
**Status:** Approved design
**Register:** Product
**Target runtime:** Raspberry Pi 3+, Node.js 20, PM2 single instance

## Summary

Replace the current flat `/menu` command grid with a status-first Home
dashboard for household members and administrators. Home answers the user's
first question—whether anything needs attention—before exposing controls.

The feature also establishes reliable Telegram interaction semantics:

- one authoritative Home session per user;
- stale keyboards cannot mutate state;
- cached status renders without probing hardware;
- critical sensor alarms are never intentionally suppressed by user settings;
- consequential actions confirm before execution;
- delivered Slice 4A gives logs, CSV, and settings a consistent route to a
  fresh Home; later Slice 4 workflow groups remain pending.

The complete experience is delivered through four implementation slices. Each
slice receives its own detailed implementation spec and plan; this document is
the umbrella design and source of product invariants.

## Context and Problem

The current menu exposes seven choices to members and nine to administrators,
mixes destinations with immediate commands, duplicates CSV and settings paths,
and uses three-column rows that compress localized labels. It does not show
home state despite calling itself a dashboard. Unknown callbacks are silently
ignored, edit failures can leave multiple active keyboards, and restart and
cleanup are reachable without menu-level confirmation.

The redesigned surface serves private Telegram chats only, consistent with the
bot-core specification. Authority is therefore keyed by Telegram user and
private chat identity.

## Users and Success Criteria

Primary users:

- household members checking status while distracted or anxious;
- technical homeowners administering sensors, storage, and the worker;
- users on narrow mobile Telegram clients in English or Ukrainian.

The design succeeds when:

1. Home can be understood in under three seconds.
2. Opening Home never waits for a live hardware probe.
3. No stale Home callback can execute a mutation.
4. Critical sensor alarms bypass every user notification-suppression setting.
5. Navigation uses stable, thumb-friendly rows of at most two peer actions.
6. Every canonical command has one menu destination.
7. External workflows can create a fresh Home from every defined exit state.
8. The worker remains below the 512 MB PM2 limit without background polling.

## Non-Goals

- Replacing slash commands; they remain the expert and recovery path.
- Moving camera, CSV, configuration, import, Drive authorization, or update
  state machines into the Home session.
- Exposing application OTA in Admin tools; `/update` remains slash-only.
- Adding background sensor-health polling.
- Making routine motion events critical without a separate severity design.
- Guaranteeing that Telegram removes every old keyboard. Correctness relies on
  server-side session validation, not visual cleanup.

## Product Vocabulary

- **Home:** the authoritative dashboard message and its owned submenus.
- **Sensor state:** the last known value persisted for an enabled sensor.
- **Reporting health:** the most recent live driver-health probe.
- **Attention:** a known sensor state classified as warning or critical.
- **Notification pause:** suppression of non-critical delivery for one user.
- **External workflow:** an independent grammY flow launched from Home but not
  governed by the Home session.
- **Authoritative session:** the sole Home token/revision that may accept
  callbacks for one user and private chat.

## Safety Invariants

### Critical delivery

Events classified as `critical` are evaluated before every suppression rule:

```text
critical → do not suppress through user settings
non-critical → evaluate timed global pause, per-target pause, quiet hours
```

The user-facing guarantee is:

> Critical sensor alarms are never silenced by notification settings.

This does not promise successful network delivery. Critical events remain
subject to the existing queue, retry, Telegram, and network behavior.

Existing configuration that permits quiet hours to suppress critical events is
deprecated and no longer controls delivery. Routine motion remains
non-critical unless a future camera-severity design explicitly changes it.

### Notification controls

All controls are scoped to the current Telegram user.

| Control | Suppresses | Duration | Critical behavior |
|---|---|---|---|
| Quiet hours | Informational notifications | Recurring schedule | Bypass |
| Per-target pause | Info and warning for one sensor/camera | Until resumed | Bypass |
| Global pause | Info, warning, and routine motion | 1, 4, or 8 hours | Bypass |

New global pauses use `nonCriticalPausedUntil`. Existing `users.muted=true`
values remain visible as a legacy indefinite pause until the user resumes them.
The UI cannot create another indefinite global pause. The legacy column is
removed only in a later migration after deployed values are cleared.

## Home Information Hierarchy

Home leads with one derived verdict using this strict priority:

1. `Attention needed`
2. `Some status is unavailable`
3. `Home looks normal`

`Home looks normal` requires every relevant sensor state to be known and a
sufficiently fresh reporting-health snapshot with no missing result. Sensor
state age alone does not invalidate an unchanged digital value; reporting
health establishes whether the driver is currently reachable.

### Normal state

```text
🏠 Home

✅ Home looks normal
6 sensors reporting · checked 4 min ago
Notifications normal

[Sensors]          [Camera]
[Notifications]    [More]
[↻ Check now]
```

### Partial state

```text
🏠 Home

❔ Some status is unavailable
Sensor states:      5 known · 1 unknown
Sensors reporting:  5 of 6 · checked 3 min ago
Notifications:      Normal

[Sensors]          [Camera]
[Notifications]    [More]
[↻ Check now]
```

### Attention state

```text
🏠 Home

⚠️ 2 sensors need attention
Front door open · Living room CO₂ high
Sensors reporting:  6 of 6 · checked 1 min ago
Notifications:      Quiet until 07:00

[Sensors]          [Camera]
[Notifications]    [More]
[↻ Check now]
```

Button positions never change based on status.

## Dashboard Screens

### Sensors

Sensors is owned by Home and renders text rows, not per-sensor buttons.

- Eight sensors per page.
- Alphabetical ordering by normalized name and immutable ID.
- A compact `Needs attention` summary names up to three warning/critical
  sensors above every page; the alphabetical list remains the source of row
  detail.
- When more than three need attention, show `3 of N shown`.
- Page copy includes `Page X of Y · N sensors`.
- Previous and Next occupy a dedicated row and render only when required.
- Check now retains the alphabetical page.
- A newly discovered critical state updates the attention summary without
  silently moving the user to a different alphabetical page.
- If the sensor set changes and the page becomes invalid, clamp to the last
  valid page and explain the change.

Member empty state:

```text
No sensors configured. Ask an administrator to add one.
```

Administrator empty state adds `Set up sensors`.

### Notifications

Rows keep stable semantic positions. Labels change in place; actions do not
reflow into another control's previous position.

```text
🔔 Notifications

Quiet hours: Off
Paused targets: 2
Critical sensor alarms are never silenced.

[Set quiet hours]
[Sensor notification settings]
[Pause non-critical notifications]
[← Back]                    [Home]
```

When a timed pause is active, the third action becomes
`Resume non-critical notifications` in the same row.

Global pause requires a duration and confirmation:

```text
Pause non-critical notifications for 4 hours?

Info, warning, and routine motion notifications will pause until 18:30.
Critical sensor alarms remain active.

[Confirm pause]
[Cancel]
```

Undo rules:

- global-pause Undo remains valid until the pause expires or changes;
- quiet-hours Undo remains valid for ten minutes;
- only the latest Undo receipt of each action type remains active;
- Undo restores state only when the expected mutation revision still matches;
- expired or superseded Undo explains why and returns to Notifications.

### More

Member:

```text
[History]           [My settings]
[Help]              [Close Home]
[Home]
```

Administrator:

```text
[History]           [My settings]
[Help]              [Admin tools]
[Close Home]
[Home]
```

History launches the current log flow and offers CSV export contextually.
`My settings` contains locale and personal preferences. Existing admin-only
system thresholds move to Admin tools → System rather than remaining in the
personal screen.
Close Home clears the active session, removes the keyboard best-effort, and
leaves localized copy stating that monitoring continues and `/menu` reopens
Home.

### Admin tools

```text
[Sensor setup]      [Storage & backup]
[System]            [Create invite]
[← Back]            [Home]
```

Canonical destinations:

- Sensor setup: add, edit, remove, import, export configuration.
- Storage & backup: Drive status, connect Drive, cleanup media.
- System: system health, system packages, restart application.
- Create invite: existing invite flow.

`System packages` maps to the OS dependency update flow. Application OTA stays
slash-only.

## Confirmation Policy

Home owns confirmations for:

- restart application;
- cleanup media;
- timed global notification pause.

Existing external workflows retain their existing confirmations for:

- sensor removal;
- configuration import;
- system package update.

No action receives two confirmation screens. Confirmation receipts expire
after two minutes, are one-shot, are bound to user/chat/session/action, and are
consumed atomically before execution.

## Authoritative Home Session

### Identity

A callback is accepted only when all of these match:

- Telegram user ID;
- private chat ID;
- callback message ID;
- 96-bit random base64url session token;
- bounded render revision.

Callback payloads use short action codes and assert the Telegram UTF-8 byte
limit in tests. Sensor names never appear in callback data; actions use compact
selectors and revalidate targets server-side.

### New Home protocol

```text
retain current active Home
        ↓
reserve pending token/revision with expiry
        ↓
send new Telegram message
        ↓
CAS-promote exact pending reservation to active
        ↓
best-effort strip previous keyboard
```

Send failure leaves the previous Home authoritative. A concurrent reservation
may supersede pending work; a losing message is stripped best-effort and its
callbacks are rejected.

Pending reservations expire after 60 seconds. A later request may replace an
expired reservation without changing the active Home.

### In-place render protocol

```text
retain active render
        ↓
reserve pending view/revision
        ↓
edit exact active message
        ↓
CAS-promote pending render
```

A callback containing the pending revision proves that Telegram presented the
pending keyboard. Validation may CAS-promote it if no newer reservation won.
Otherwise the callback receives updating or stale recovery and cannot mutate.

### Processing order

1. Acknowledge the callback promptly.
2. Parse bounded callback data.
3. Load current user role and locale.
4. Validate active/pending session identity.
5. Validate action receipt or mutation revision.
6. Execute or render localized recovery.

grammY runner processing is sequentialized by private user/chat key before
locale middleware and handlers. Database CAS remains authoritative across
restarts and future multi-process changes.

### Closed, stale, and unavailable states

- Closed Home has no active session.
- Anything not matching active identity is stale; no historical stale rows are
  required.
- Stale/unknown callbacks never mutate and offer `Open new Home`.
- `Open new Home` is a harmless recovery action using the new-message protocol.
- SQLite validation failure fails closed for all mutations and recommends
  direct slash commands.
- Telegram cleanup is best-effort; logical rejection provides correctness.

## Home Summary and Health Cache

Home reads current persisted sensor values, configuration, user pause state,
and per-target pauses on every render. Only live reporting health is cached.

The bounded in-memory health snapshot contains:

- probe completion time;
- enabled sensor IDs used by the probe;
- online sensor IDs;
- missing, failed, and timed-out results.

If current enabled IDs differ from the snapshot, reporting health becomes
`Needs check`. No periodic refresh runs.

A complete successful health snapshot is fresh for two minutes. Older,
partial, failed, or absent snapshots cannot support the normal Home verdict.

`Check now` uses one system-wide single-flight probe. Concurrent users share
the result. Results may update the cache after the initiating Home becomes
stale, but only the currently authoritative token/revision may edit a message.
Last-known content remains visible during checking and after failure.

The shared sensor-state classifier belongs in the sensors domain/application
layer so `/status`, Home, Sensors, and notification decisions do not drift.

## External Workflow Contract

Camera, logs, CSV, settings, configuration, Drive, import, and system package
update remain independent workflows. A shared interface-layer Home launcher
adds consistent navigation without importing Telegram infrastructure into
application or domain code.

Every workflow state is explicitly classified as:

- `continuing`: remain in the workflow;
- `cancelPending`: clear pending input/confirmation, then create Home;
- `leaveRunning`: work has started; create Home without cancelling it;
- `alreadyTerminal`: create Home directly.

`Return to Home` always creates and promotes a fresh Home. It never attempts to
jump to or reuse an older Home message.

Workflow coverage is implemented in bounded groups:

1. **Slice 4A — delivered:** logs, CSV, settings.
2. **Later Slice 4 — pending:** configuration, import, Drive, and system
   package update.
3. **Later Slice 4 — pending:** camera as a separate change because it has
   the largest state surface.

Post-restart messages that currently support text only are not silently claimed
to have buttons. If Return Home is required on such a message, the messaging
port must first gain an explicit actionable-message capability.

## Operational State Matrix

The implementation specs must cover these states explicitly.

### Home

- initial health cache absent;
- fresh normal;
- attention needed;
- stale health;
- partially available;
- unavailable;
- checking;
- refresh timeout/failure while preserving last-known content;
- zero configured sensors;
- role or locale changed.

### Sensors

- no sensors;
- known and unknown states;
- one or multiple attention states;
- single and multiple pages;
- current page clamped after add/remove;
- health snapshot no longer matches enabled sensor IDs.

### Session

- simultaneous `/menu` calls;
- simultaneous Return Home calls;
- send/edit failure;
- CAS promotion loss;
- expired pending reservation;
- crash before and after Telegram send;
- message deleted or edit forbidden;
- visually orphaned but non-authoritative keyboard;
- Close Home when markup removal fails.

### External workflows

- starting;
- continuing input or navigation;
- cancellation;
- timeout;
- partial completion;
- success;
- recoverable failure;
- running work that cannot be cancelled;
- restart-interrupted in-memory state.

## Architecture Boundaries

The feature follows the repository's hexagonal dependency rule.

### Domain/application

- notification suppression policy and mutation revisions;
- Home verdict and sensor-state classification;
- Home summary query;
- refresh-monitoring use case;
- session reservation/promotion/close use cases;
- confirmation and Undo use cases;
- ports for Home sessions, action receipts, health snapshots, sensor paging,
  clock, and Home message delivery.

### Infrastructure

- Drizzle Home-session and action-receipt adapters;
- in-memory adapters for use-case tests;
- bounded in-memory health-snapshot adapter;
- deterministic Drizzle sensor-page query;
- grammY sequentialization and Home message adapter.

### Interface

- thin callback parsing and error-to-locale mapping;
- pure localized render models converted to grammY keyboards;
- shared terminal-navigation helper for external workflows.

Bot handlers do not query Drizzle directly. Nest module files remain composition
roots and bind ports to adapters through symbols.

## Delivery Slices

### Slice 1 — Notification safety foundation

- critical bypass invariant;
- timed per-user global pause;
- legacy mute compatibility;
- mutation revisions and Undo receipts;
- focused schema migration and domain/application/integration tests.

No new menu is exposed in this slice.

### Slice 2 — Authoritative Home

- runner sequentialization;
- active/pending Home sessions;
- two-phase send/edit protocols;
- stale, Close Home, and Open new Home recovery;
- Home verdict and health cache;
- Home and Sensors screens.

Existing command destinations may remain behind a transitional More screen.

### Slice 3 — Notifications and canonical navigation

- Notifications screen and timed pause flow;
- quiet-hours and per-target controls;
- More and Admin tools hierarchy;
- restart and cleanup confirmations;
- final EN/UK labels and row layouts.

Slice 3 retires the transitional Home-to-legacy Notifications/More routes.
Canonical Storage cleanup always starts from Home confirmation; it never emits
the legacy direct `clean:trigger` control. Independent external workflows are
intentionally not given a Return Home button until Slice 4.

### Slice 4 — External workflow return contract

- shared terminal-navigation/Home-launcher helper;
- **Slice 4A — delivered:** logs, CSV, and settings;
- **later Slice 4 — pending:** configuration, import, Drive, and system
  package update;
- **later Slice 4 — pending:** camera in a separate sub-slice.

The delivered Slice 4A staging status is live and localized: its `rh:c:r`
action opens a fresh Home while the detached CSV upload and its active lock keep
running. It does not cancel either. Later Slice 4 scope remains explicitly
pending.

Each slice has a separate implementation spec, plan, migration where required,
focused test suite, review, and rollback boundary. Schema fields are introduced
only in the slice that consumes them.

## Verification Strategy

Follow the repository's three test tiers.

### Domain unit tests

- critical bypass across every suppression rule;
- Home verdict truth table;
- sensor state classification;
- quiet-window timezone and DST behavior;
- mutation revision and Undo invariants;
- callback value parsing as pure domain/application logic where applicable.

### Application use-case tests

- session active/pending CAS transitions;
- concurrent opens and Return Home;
- single-flight refresh and stale initiator;
- timed pause expiry;
- Undo success, expiry, consumption, and CAS loss;
- stable paging behavior;
- workflow exit-policy orchestration.

Use in-memory adapters and injected clock/randomness.

### Infrastructure integration tests

- generated migration from the existing schema;
- Drizzle/in-memory adapter parity;
- legacy mute compatibility;
- pending-session expiry and restart recovery;
- deterministic page query and clamping;
- grammY callback byte limits and transport behavior.

### Interface tests

- current role and locale on every callback;
- stale/wrong user/chat/message/token/revision rejection;
- localized empty, loading, partial, error, confirmation, Undo, and recovery
  states;
- external workflow terminal/continuing classification and state cleanup;
- Telegram send/edit/delete failure mapping.

### Manual constrained-environment checks

- narrow iOS and Android Telegram layouts in English and Ukrainian;
- VoiceOver and TalkBack reading order;
- process restart with active and pending Home sessions;
- network loss during refresh and message promotion;
- Pi memory remains below 512 MB;
- no background polling or unbounded session/action/cache growth.

## Acceptance Criteria

- `/menu` renders cached Home without first probing hardware.
- Home never renders a normal verdict with unknown required data.
- Critical sensor alarms are never suppressed by user notification settings.
- Global pause choices are exactly 1, 4, and 8 hours and expire by timestamp.
- At most one Home session accepts callbacks per user/private chat.
- Stale Home callbacks never mutate state.
- Button positions remain stable within each locale and screen state.
- Member and administrator menus contain no duplicate command destinations.
- External workflow exit states use the shared Home-launcher contract.
- Existing slash commands continue to work throughout phased delivery.
- Every migration is generated from `src/database/schema.ts` and verified from
  an existing database state.
- Runtime memory remains below the PM2 512 MB limit.

## Rollout and Compatibility

- Ship slices in dependency order; do not expose UI that depends on a later
  safety or persistence slice.
- Announce the critical-delivery behavior change in release notes.
- Preserve legacy global pauses until users resume them.
- Keep direct slash commands available as recovery during dashboard failures.
- Each slice must be independently reviewable and revertible without corrupting
  notification or session state.

## Resolved Decisions

- Status-first Home is the selected direction.
- Cached-first rendering with explicit Check now is required.
- Exactly one authoritative Home exists per user/private chat.
- Session correctness uses custom ports/adapters rather than adopting
  `@grammyjs/menu`.
- Critical sensor alarms bypass all user suppression settings.
- Global pauses are per-user, time-bound to 1, 4, or 8 hours.
- Per-target pauses remain per-user and indefinite until resumed.
- Return to Home always creates a fresh Home.
- Home authority covers Home and owned submenus only.
- Delivery is phased into four implementation slices.

No product or architectural questions remain open in this umbrella design.

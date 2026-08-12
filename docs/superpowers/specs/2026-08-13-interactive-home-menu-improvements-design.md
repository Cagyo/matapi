# Interactive Home Menu Improvements Design

**Date:** 2026-08-13
**Status:** Proposed for written review
**Register:** Product
**Target runtime:** Raspberry Pi 3+, Raspbian, Node.js 22, PM2 single instance

## Summary

Improve the authoritative Telegram Home dashboard so household members can
understand safety, freshness, notification coverage, and recovery actions in
under three seconds. The implementation uses a projection-first refinement:
application-layer screen projections expose the data the interface needs, and
the locale-aware renderer turns that projection into concise Telegram text and
inline keyboards.

The change closes the twelve findings recorded in the 2026-08-13 Impeccable
critique. It preserves the existing Home authority, callback validation,
workflow-return receipts, role checks, database schema, and external workflow
destinations.

This design narrows and amends the approved umbrella design in
`docs/superpowers/specs/2026-07-13-telegram-home-dashboard-design.md`. Where the
two differ, this document controls the following details:

- **Check now** is contextual on the root Home screen instead of permanently
  occupying a row.
- quiet-hour presets move from Notifications to a dedicated Home-owned screen;
- installed Camera capability remains visible when temporarily unavailable;
- refresh failure is shown as a transient authoritative-Home notice rather
  than silently returning to cached status.

## Goals

- Make every attention verdict identify the affected sensors and their
  household-readable state.
- Show when sensor state and reporting-health information was observed.
- Keep routine Home within four peer actions whenever the system is healthy.
- Make notification suppression precise: controls always say
  **non-critical**, and copy repeats that critical alarms remain active.
- Separate notification summary, quiet-hours selection, target selection, and
  timed global pause into distinct decisions.
- Give unavailable, stale, and failed states a direct recovery action.
- Explain the effect of cleanup and restart before confirmation.
- Keep an installed Camera capability discoverable when it is disabled, busy,
  or needs attention.
- Use household language in member-facing UI while retaining technical detail
  in administrator-only destinations where it is necessary.
- Preserve English, Russian, and Ukrainian catalog parity.

## Non-goals

- No database schema or migration changes.
- No replacement of Telegram inline keyboards or slash commands.
- No change to critical-notification delivery policy.
- No change to Home session identity, callback token size, revision semantics,
  or workflow-return receipt semantics.
- No new background polling or persistent health history.
- No redesign of sensor configuration, Camera workflows, Drive authorization,
  logs generation, CSV generation, or package update internals.
- No attempt to emulate a disabled Telegram inline button; Telegram does not
  provide one.
- No broad refactor of the Telegram context outside files touched by these
  presentation and navigation changes.

## Product Invariants

1. Home remains understandable without a live hardware probe.
2. Home renders only cached persisted sensor state and the bounded cached
   reporting-health snapshot.
3. A stale Home callback never mutates state.
4. Critical sensor alarms remain deliverable regardless of quiet hours,
   per-target pauses, legacy pause, or timed global pause.
5. Every user-visible string comes from the active locale catalog.
6. Every actionable Camera control represents a currently operational Camera
   capability; unavailable Camera status is text, never a fake button.
7. Destructive confirmation receipts remain one-shot, session-bound, and
   valid for two minutes.
8. A failed refresh preserves and clearly labels the previous cached result.
9. All new callback payloads remain at or below Telegram's 64-byte UTF-8 limit.
10. The change introduces no unbounded lists, buffers, background timers, or
    additional process-wide caches.

## Primary User Journey

The user opens `/menu` while distracted or concerned. The first lines answer:

1. Does anything need attention?
2. Which device is affected and what does its state mean?
3. How fresh is the status?
4. Will notifications reach me?

The keyboard then offers the smallest useful set of destinations. Healthy
Home omits **Check now** because passive freshness already establishes trust.
Stale, absent, failed, or unavailable monitoring shows **Check now** as the
recovery action.

## Home Information Hierarchy

### Normal

```text
🏠 Home

✅ Everything looks normal
Sensors reporting: 6 of 6 · checked less than a minute ago
Notifications: normal

[📊 Sensors]       [📷 Camera]
[🔔 Notifications] [⋯ More]
```

### Attention

```text
🏠 Home

⚠️ 2 sensors need attention
🚪 Front door: Opened · 2 min ago
🌬️ Living room CO₂: 1,240 ppm ⚠️ · 1 min ago
Sensors reporting: 6 of 6 · checked less than a minute ago
Notifications: quiet until 07:00

[📊 Sensors]       [📷 Camera]
[🔔 Notifications] [⋯ More]
```

Home shows at most three attention rows, using the already sorted
`HomeSummary.attention` projection. When more attention items exist, append a
localized `+N more` line and keep **Sensors** as the detail destination.

### Partial or stale

```text
🏠 Home

❔ Some status is unavailable
States: 5 reporting · 1 unknown
Monitoring: last checked 8 min ago
Notifications: normal

[📊 Sensors]       [📷 Camera]
[🔔 Notifications] [⋯ More]
[↻ Check now]
```

**Check now** appears on Home when any of the following is true:

- no completed health snapshot exists;
- the health snapshot is stale;
- the latest snapshot contains missing, offline, failed, or timed-out sensors;
- the immediately preceding manual check failed.

The Sensors screen keeps **Check now** because it is an explicit diagnostic
surface and already has a stable refresh workflow.

## Semantic Sensor Presentation

The renderer must never print `Sensor.lastValue` directly.

Presentation reuses the existing localized status vocabulary and the existing
`classifySensorState` result:

- digital contact: **Opened** / **Closed**;
- leak hazard: **Leak detected** / **No leak**;
- alarm, power, motion, and button: use their configured localized step labels;
- UART: numeric value plus `ppm` and warning/critical marker;
- invalid or absent value: **Unknown**;
- `lastValueAt`: localized relative age, with future timestamps treated as
  unknown rather than a negative age.

Sensor names remain user-provided plain text. No Telegram parse mode is added.
The renderer continues to rely on plain-text transport so names containing
format punctuation cannot alter markup.

The Sensors page retains its eight-item pagination and alphabetical ordering.
It replaces raw rows such as `Front door: true` with localized semantic rows.
The attention summary uses the same formatter as the page, so overview and
detail cannot disagree about state wording.

## Reporting Freshness

`GetHomeSummaryUseCase` already receives `ClockPort` time and the cached
`HomeHealthSnapshot.completedAt`. Its projection adds the observation time
needed for deterministic relative-age rendering. No renderer or domain logic
calls `Date.now()` for new Home behavior.

Freshness copy distinguishes:

- **never checked**;
- **checked less than a minute ago**;
- **checked N minutes/hours ago**;
- **check in progress**;
- **last check failed — showing the previous result**.

A manual refresh keeps the current authoritative Home flow:

1. render the checking state;
2. invoke `RefreshHomeMonitoringUseCase`;
3. render the refreshed Home on success;
4. render the cached Home with a transient localized failure notice on the
   `{ kind: 'failed' }` result or an unexpected thrown error.

The transient render carries both the localized notice and
`forceCheckNow: true` through `RenderHomeUseCase` to `GetHomeScreenUseCase`.
That ephemeral flag makes the replacement authoritative Home include
**Check now** even when its preserved snapshot was still technically fresh.
Neither the notice nor the flag is persisted in `HomeView`; the next ordinary
or successful render removes both. This avoids a schema change and prevents an
old failure notice from becoming durable session state.

## Camera Capability Presentation

The Home application projection replaces `cameraAvailable: boolean` with a
small capability union:

```ts
type HomeCameraCapability =
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: 'disabled' | 'busy' | 'attention' | 'probe-failed' }
  | { kind: 'absent' };
```

- **available:** render the Camera button;
- **unavailable:** omit the non-functional button and add one concise status
  line explaining why Camera is unavailable;
- **absent:** omit Camera entirely because no Camera feature is installed.

The application projection derives this union from `FeatureAvailabilityPort`.
The renderer does not inspect feature internals. A failed availability query is
`probe-failed`, not silently indistinguishable from absence.

Aggregate precedence across Motion and RTSP is deterministic: **available** if
either capability is operational; otherwise **unavailable** if either is
installed or either inspection failed; **absent** only when both inspections
complete and neither feature is installed.

## Notifications Information Architecture

### Notifications summary

```text
🔔 Notifications

Quiet hours: 22:00–07:00
Device alerts paused: 2
Non-critical alerts: active
Critical sensor alarms remain active.

[🌙 Quiet hours]
[🎯 Device alert settings]
[⏸ Pause non-critical alerts]
[🏠 Home]
```

When a legacy or timed global pause is active, the third action becomes
**Resume non-critical alerts**. Existing receipt-backed undo controls may
appear below the affected setting; they are recovery controls, not peer
configuration choices.

### Quiet-hours picker

Quiet-hour presets move to a dedicated Home-owned view:

```text
🌙 Quiet hours

Choose when routine informational alerts are quiet.
Warning and critical sensor alarms remain active.

[✓ 22:00–07:00]
[23:00–06:00]
[00:00–08:00]
[Turn quiet hours off]
[« Notifications] [🏠 Home]
```

The selected preset is marked with both `✓` and the full time range. If a
stored range does not match a canonical preset, the copy shows it as the
current custom range while none of the preset buttons is marked.

The new view is added to `HomeView`, `HomeScreen`, strict view codecs, parent
navigation, callback parsing, and callback routing. It uses the existing
quiet-hours mutation and Undo receipt; no new repository operation or table is
introduced.

### Notification targets

The message body shows the page summary once and does not repeat every target
name above identical buttons. Each target button carries state:

```text
[Front door · Active]
[Garage camera · Paused]
```

The existing eight-target bound, stable index callback, paging, and strict
target-reference persistence remain unchanged. Target detail retains the
single Pause/Resume action and explicit Back/Home row.

All global pause labels say **non-critical alerts**. The phrase **Pause alerts**
is not used for the global control because it could imply that critical alarms
are silenced.

## Empty, Unavailable, and Recovery States

### No sensors

- Member: explain that an administrator must add a sensor; provide Home.
- Administrator: explain that no sensors exist and provide a real
  **Set up sensors** action that routes to the canonical Sensor setup screen.

The setup action is authorized in `HomeNavigationUseCase` and never routes a
non-admin into an admin view.

### Home recovery

- stale/closed: **Open new Home**;
- updating: **Try Home again**;
- unavailable: **Try Home again**, plus concise direct-command fallback copy;
- failed monitoring refresh: authoritative cached Home plus **Check now**;
- failed cleanup start: **Try cleanup again** and Back/Home;
- Camera unavailable: explanatory status with no fake action.

Updating and unavailable recovery reuse the stateless Open-new-Home callback.
They do not invent a second authority protocol.

## Consequential Confirmations

Home-owned confirmation screens use explicit consequence copy and an explicit
Cancel label. The Cancel control uses the existing validated Back route; no new
mutation action is needed.

### Cleanup

```text
Clean up stored camera media?

Old eligible media may be removed. Active recordings and protected archive
items are not affected.

[Confirm cleanup]
[Cancel] [🏠 Home]
```

### Restart

```text
Restart the home service?

Monitoring and bot controls may be unavailable briefly. The final result will
arrive after recovery.

[Confirm restart]
[Cancel] [🏠 Home]
```

Confirmation receipt creation, expiry, claim, and external execution remain
unchanged. The restart wording uses **home service** in member-facing copy;
administrator destinations may retain the technical term **worker** where it
is needed for diagnosis.

## Vocabulary Changes

| Current | Replacement |
|---|---|
| legacy pause | older non-critical pause |
| notification target | device alerts / alert source |
| Pause alerts | Pause non-critical alerts |
| Restart worker? | Restart the home service? |
| Export CSV | Download sensor history |
| States: known / unknown | States: reporting / unknown |

Internal action names, receipt kinds, and callback codes do not change merely
to match presentation wording.

## Architecture and File Responsibilities

### Sensors domain

The existing `classifySensorState` remains the source of semantic level and
active state. If formatting reuse requires a new pure projection helper, it
lives beside the classifier and returns data only; it must not import locale or
Telegram types.

### Telegram application

- `GetHomeSummaryUseCase` projects deterministic observation time and existing
  attention/freshness data.
- `GetHomeScreenUseCase` projects `HomeCameraCapability`, the new quiet-hours
  screen, and the ephemeral `forceCheckNow` presentation override.
- `HomeNavigationUseCase` authorizes the admin sensor-setup empty-state action
  and routes the quiet-hours view through existing mutation effects.
- `RenderHomeUseCase` accepts an optional transient notice and
  `forceCheckNow` override, forwarding both without persisting them in
  `HomeView`.

Application code continues to depend only on domain types and published ports.
No application use case imports grammY, Drizzle, or a concrete adapter.

### Telegram domain

- `HomeView` adds the quiet-hours view and preserves strict canonical encoding.
- `HomeAction` adds only the navigation action required to open that view.
- Existing compact quiet-hours mutation callbacks remain unchanged.

### Telegram interfaces and infrastructure

- `home-renderer.ts` owns text hierarchy and keyboard row composition.
- Locale catalogs own every user-visible phrase and pluralization rule.
- `HomeHandler` maps refresh success/failure to ordinary or transient-notice
  rendering.
- `TelegramHomeMessageAdapter` applies the optional notice consistently to send
  and edit operations.

## Data Flow

```text
SensorQueryPort + HomeHealthSnapshotPort + ClockPort + user settings
                              │
                              ▼
                   GetHomeSummaryUseCase
                              │
                              ▼
                    GetHomeScreenUseCase
                ┌─────────────┴─────────────┐
                │                           │
        Home screen projection      Camera capability projection
                │                           │
                └─────────────┬─────────────┘
                              ▼
                     RenderHomeUseCase
                              │
                              ▼
                HomeMessageDeliveryPort
                              │
                              ▼
              TelegramHomeMessageAdapter → Telegram
```

## Error Handling

- Expected refresh failures remain a typed result from
  `RefreshHomeMonitoringUseCase`; Home renders cached state with localized
  recovery copy.
- An unexpected refresh throw is logged by the owning application/interface
  boundary and receives the same safe user-facing recovery state.
- Feature-availability read failure becomes a non-actionable Camera
  `probe-failed` presentation state and does not expose the underlying error.
- Delivery failures continue through the existing abandon/reopen Home
  protocol. A failed edit never promotes a pending render.
- Unknown errors are logged through Nest `Logger`; raw messages and stack
  traces are never sent to users.

## Localization

English, Russian, and Ukrainian receive identical locale-object shapes and
equivalent meaning. Tests cover:

- singular/plural attention overflow;
- relative health and sensor age boundaries;
- all semantic sensor step types;
- non-critical alert safety wording;
- Camera unavailable reasons;
- confirmation impact and Cancel labels;
- replacement terminology for history download and older pause state.

Localized button rows must be inspected as logical rows rather than pixel
widths. No row adds more than two prose labels; quiet-hour time-only options
are one button per row to avoid compression.

## Testing Strategy

### Domain/unit

- Extend sensor-state presentation coverage for every digital step type, UART
  ppm, invalid values, absent values, and future timestamps.
- Extend Home callback and Home view codec tests for the new quiet-hours route,
  canonical encoding, malformed payload rejection, and 64-byte bounds.

### Application/use-case

- `GetHomeSummaryUseCase`: deterministic observation time, attention ordering,
  and freshness inputs.
- `GetHomeScreenUseCase`: Camera available/unavailable/absent/probe-failed and
  role-aware admin setup routing.
- `HomeNavigationUseCase`: quiet-hours parentage, valid/invalid source views,
  admin setup authorization, stale action rejection, and unchanged receipt
  effects.
- `RefreshHomeMonitoringUseCase`: existing failed result remains authoritative
  and previous snapshot is preserved.
- `RenderHomeUseCase`: transient notice and forced Check action are delivered
  but not encoded into persisted `HomeView`.

### Interface/infrastructure

- `home-renderer.test.ts`: root states, semantic sensor rows, contextual Check
  now, Camera status, notification summary, quiet-hours picker, target state,
  empty admin setup action, explicit confirmation cancellation, and recovery
  rows in all three locales.
- `home.handler.test.ts`: refresh success, expected failure, unexpected throw,
  stale/updating/unavailable recovery keyboards, and existing workflow-leave
  ordering.
- `telegram-home-message.adapter.test.ts`: notice composition is identical for
  send and edit and never enables a parse mode.
- Locale catalog-shape tests guarantee English/Russian/Ukrainian parity.

Focused tests run after each slice. Final verification runs `yarn test`,
`yarn build`, and `yarn lint` while preserving unrelated working-tree changes.

## Delivery Slices

1. **Semantic presentation and freshness:** localized sensor formatting,
   observation time, attention rows, and contextual Check now.
2. **Recovery and capability projection:** transient refresh failure notice,
   retry keyboards, admin empty-state setup action, and Camera capability.
3. **Notification information architecture:** dedicated quiet-hours view,
   precise non-critical wording, selected presets, and target state labels.
4. **Consequential actions and vocabulary:** cleanup/restart impact, explicit
   Cancel, household terminology, and history-download labels.
5. **Cross-locale and regression verification:** catalog parity, callback
   bounds, workflow invariants, full test/build/lint pass.

Each slice is independently testable and reviewable. No slice requires a
database migration, dependency installation, or external service.

## Acceptance Criteria

1. Attention Home names up to three affected sensors with semantic state and
   age, plus a localized overflow count.
2. No Home or Sensors row prints raw boolean sensor values or an unexplained
   dash.
3. Admin sensor empty state includes a working, authorized Sensor setup button.
4. Home reports last-check age and distinguishes never, stale, checking, and
   failed states.
5. Cleanup and restart state impact and expose explicit Confirm and Cancel.
6. Stale, updating, unavailable, refresh-failed, and cleanup-failed states
   provide a safe recovery path.
7. Notifications exposes summary actions rather than four presets in one row.
8. Quiet hours marks the active preset; target buttons expose Active/Paused.
9. Healthy root Home omits Check now; stale/failed/absent Home shows it.
10. Installed but unavailable Camera capability remains visible as status.
11. Refresh failure says that cached information is being shown and permits a
    new check.
12. Household-facing copy removes or explains legacy pause, target, worker,
    known/unknown, and CSV terminology.
13. Existing authoritative Home, workflow-return, notification-safety, role,
    and callback-size tests continue to pass.
14. English, Russian, and Ukrainian catalogs have identical shapes.
15. `yarn test`, `yarn build`, and `yarn lint` pass without a schema migration.

## Recommended Impeccable References for Implementation

- `reference/clarify.md` for household vocabulary, recovery copy, and safety
  wording.
- `reference/distill.md` for Notifications hierarchy and action reduction.
- `reference/harden.md` for unavailable, stale, confirmation, localization,
  and edge states.
- `reference/polish.md` for final cross-state and cross-locale consistency.

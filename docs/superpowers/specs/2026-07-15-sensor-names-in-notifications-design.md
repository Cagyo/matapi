# Sensor Names in Immediate Notifications

## Goal

Show the user-configured sensor name as the subject of every immediate queued
sensor-event notification handled by `NotificationService.process`. This scope
includes routine changes, triggered and resolved alarms, and flapping faults.
It does not include motion captions, system-start status messages, or other
notification paths.

For a digital contact configured as `Front_Door`, the raw
`NotificationMessage.text` must be exactly:

```text
ℹ️ *Front_Door:* Closed (was Opened)
```

This is a raw-text contract. `TelegramNotifierAdapter` currently sends event
notifications without a Telegram parse mode, so the asterisks are transport
text rather than a promise that Telegram renders the subject in bold. Rich-text
rendering is a separate concern.

The sensor type, digital step type, stable sensor ID, and queued payload name
must not replace the current configured name while an active sensor record is
available.

## Current-State Finding

The current source already implements the intended resolution order for
immediate notifications:

1. active `sensor.name`;
2. the name captured in the queued event payload;
3. stable sensor ID.

`EventQueueService` stores `sensor.name` in the payload when its active-only
sensor lookup succeeds, and offline summaries read that stored value.
`DrizzleSensorQuery`, sensor creation, rename, and configuration import all
preserve the explicit name field. Sensor type only selects an icon, and digital
step type only selects state wording.

The label `Switcher` does not occur under `src/` or `test/` as a production
notification subject. It does occur in documentation as a generic description
of the digital inversion control. The observed notification may therefore come
from persisted runtime data or a deployed build that does not match this
checkout. Production formatting must not be changed unless the mismatch is
reproduced against the current source.

## Behavior

### Immediate queued sensor-event delivery

Resolve the active sensor by the event's stable sensor ID and use its current
`name` for routine changes, triggered alarms, resolved alarms, and flapping
faults. Broadcast and per-recipient delivery use the same raw message text.

### Fallbacks

- If the active sensor is not returned during notification delivery, use the
  name previously captured in the queued event.
- If a legacy event has no stored name, use the stable sensor ID.
- If a sensor is renamed after enqueue but before immediate processing, the
  latest active name may be shown.
- Offline summaries continue to use the event-time name stored in the payload.
  A difference between an immediate message and an older offline summary after
  a rename is acceptable.

### Enqueue timing limitation

The queued-name fallback is guaranteed only when the name was captured before
the sensor became unavailable. Sensor events enter an asynchronous processing
backlog, and `EventQueueService` enriches them through an active-only lookup. If
a sensor is disabled or deleted after driver emission but before enrichment,
the payload may contain no name and notification delivery will fall back to the
stable sensor ID. This race is acceptable; carrying names in `SensorEvent` or
performing archived lookups is outside this change.

## Minimal Change Strategy

Add an application-level regression test whose identity fields and queued name
are deliberately different:

```text
active sensor:
  id: gpio_17
  name: Front_Door
  type: digital
  stepType: contact
  severity: info
  enabled: true

queued event:
  sensorId: gpio_17
  payload.name: Switcher
  payload.severity: info
  oldValue: true
  newValue: false
```

The test query must be ID-aware: it returns the active sensor only for
`findById('gpio_17')`. The test must also assert that this exact ID was queried.
It must not use a stub that returns an arbitrary sensor regardless of the
requested ID.

The expected raw notification text is exactly:

```text
ℹ️ *Front_Door:* Closed (was Opened)
```

This proves that the stable ID resolves the correct active record and that the
active name overrides both the deliberately incorrect payload name and the
distinct type and step-type fields.

Add focused application-level coverage for the remaining resolution order:

1. an active name overrides a different payload name;
2. a missing or disabled active sensor uses the queued payload name;
3. a missing active sensor and missing payload name use the stable sensor ID.

These are name-resolution tests, not duplicate formatter-branch tests. If the
primary regression passes without a production change, keep the formatter
unchanged and diagnose the runtime sensor record and deployed build.

## Important Edge Cases

- An active name overrides an older or incorrect payload name for immediate
  delivery.
- A queued event remains understandable after its sensor is disabled or
  deleted only when enrichment captured the name before that transition.
- A legacy or raced event with no captured name remains identifiable by stable
  sensor ID.
- An old payload that already contains an undesired label cannot recover a
  different historical name; adding archive lookups for this rare case is not
  justified.
- Current mutation paths limit configured names to alphanumerics and
  underscores. Because this change retains the existing plain-text Telegram
  transport, it introduces no escaping change. If a future change enables
  Markdown or HTML parsing, dynamic names must use format-specific escaping or
  Telegram message entities; underscores are not automatically safe in
  Markdown.

## Non-Goals

- No database or event-payload migration.
- No new name-resolver abstraction.
- No archived-sensor lookup during notification delivery.
- No driver, sensor configuration, localization, or state-wording changes.
- No Telegram parse-mode, entity, or rich-text-rendering change.
- No change to motion captions, system-start status, or notification paths
  outside `NotificationService.process`.
- No duplicate test for every formatter branch; all immediate variants consume
  the single name resolved by `NotificationService`.
- No deployment or runtime-data mutation as part of the repository change.

## Verification and Acceptance

Run the focused event queue, notification service, event summary, and Telegram
notifier adapter tests. If the new regressions pass, run the full test suite and
build in the subsequent implementation phase.

The change is accepted when all of the following hold:

- an ID-aware lookup of active sensor `gpio_17` with `name = Front_Door`
  produces the exact raw routine message
  `ℹ️ *Front_Door:* Closed (was Opened)`;
- the active name overrides a deliberately different queued payload name;
- an unavailable active sensor falls back to its captured payload name;
- a legacy event without a captured name falls back to stable sensor ID;
- broadcast and per-recipient delivery receive the same resolved raw text; and
- no production formatter change is made when these regressions pass against
  the current source.

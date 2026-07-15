# Sensor Names in Notifications

## Goal

Show the user-configured sensor name as the subject of every sensor
notification. A digital contact configured as `Front_Door` must render as:

```text
ℹ️ *Front_Door:* Closed (was Opened)
```

The sensor type, digital step type, and stable sensor ID must not replace the
configured name while that name is available.

## Current-State Finding

The current source already implements the intended resolution order for
immediate notifications:

1. active `sensor.name`;
2. the name captured in the queued event payload;
3. stable sensor ID.

`EventQueueService` stores `sensor.name` in the payload, and offline summaries
read that stored value. `DrizzleSensorQuery`, sensor creation, rename, and
configuration import all preserve the explicit name field. Sensor type only
selects an icon, and digital step type only selects state wording.

The literal label `Switcher` does not occur in this repository. The observed
output may therefore come from persisted runtime data or a deployed build that
does not match this checkout. Production formatting must not be changed unless
the mismatch is reproduced against the current source.

## Behavior

### Immediate delivery

Resolve the active sensor by stable ID and use its current `name` for routine
changes, critical alarms, resolved alarms, and flapping faults. Broadcast and
per-recipient delivery use the same rendered message.

### Fallbacks

- If the sensor is disabled, deleted, or otherwise not returned by the sensor
  query, use the name captured in the queued event.
- If a legacy event has no stored name, use the stable sensor ID.
- If a sensor is renamed before immediate delivery, the latest active name may
  be shown.
- Offline summaries continue to use the event-time name stored in the payload.
  A rare difference between an immediate message and an older offline summary
  after a rename is acceptable.

## Minimal Change Strategy

Add one application-level regression test whose sensor identity fields are
deliberately different:

```text
id: gpio_17
name: Front_Door
type: digital
stepType: contact
oldValue: true
newValue: false
```

The expected notification is exactly:

```text
ℹ️ *Front_Door:* Closed (was Opened)
```

If this regression fails, change only the boundary that substituted another
field for `sensor.name`. If it passes without a production change, keep the
formatter unchanged and diagnose the runtime sensor record and deployed build.

## Important Edge Cases

- An active name overrides an older or incorrect payload name for immediate
  delivery.
- A queued event remains understandable after its sensor is disabled or
  deleted because the payload retains the name captured at enqueue time.
- An old payload that already contains an undesired label cannot recover a
  different historical name; adding archive lookups for this rare case is not
  justified.
- Name validation already limits configured names to alphanumerics and
  underscores, so this change does not introduce a new escaping requirement.

## Non-Goals

- No database or event-payload migration.
- No new name-resolver abstraction.
- No archived-sensor lookup during notification delivery.
- No driver, sensor configuration, localization, or Markdown changes.
- No duplicate test for every formatter branch; all immediate variants consume
  the single name resolved by `NotificationService`.
- No deployment or runtime-data mutation as part of the repository change.

## Verification and Acceptance

Run the focused event queue, notification service, and event summary tests. If
the new regression passes, run the full test suite and build in the subsequent
implementation phase.

The change is accepted when an active sensor record with
`name = Front_Door` produces `*Front_Door:*` in the routine state-change
notification, with neither its type nor its step type substituted for that
subject.

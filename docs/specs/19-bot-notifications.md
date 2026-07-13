# 19 — Bot Notifications

## Dependencies
- 05-event-queue.md (event queue)
- 01-database.md (users, user_sensor_mutes, sensors tables)
- 12-bot-cmd-mute.md (mute/quiet hours data)
- ../ports-and-adapters.md (`NotifierPort`, `SensorQueryPort`, `UserRepositoryPort`, `ClockPort`)

## Overview

Notifications are the output side of the event queue. When an event is ready to send, the notification system decides who receives it, whether it's suppressed, and how it's formatted. The pipeline is application-layer code that depends only on ports — no Drizzle, no grammY, no `Date.now()`, no `console.log`.

## Notification Flow

```
Event created (sensor state change, motion, system)
       │
       ▼
Write to events table (sent_at = NULL)
       │
       ▼
NotificationService.process(event)
       │
       ├─ Resolve severity (sensor row / payload / flapping-fault ⇒ warning)
       ├─ Debounce gate (per-sensor): non-critical repeated identical value? → mark sent, stop
       │     Critical is NEVER debounced — a re-asserted identical alarm
       │     (e.g. smoke holding `active`) is always eligible for delivery.
       ├─ No registered recipients? → broadcast to shared chat (matrix NOT applied), stop
       ├─ For each recipient (per-recipient fan-out matrix):
       │   ├─ critical? → ALWAYS send (bypasses mute, timed pause, per-sensor pause, quiet hours)
       │   ├─ legacy muted OR timed pause active OR per-sensor pause? → skip
       │   ├─ (info OR routine motion) AND quiet hours? → skip   (warning bypasses quiet hours)
       │   └─ Send message
       │
       ▼
Mark event sent_at in DB (unless every eligible send failed → stay queued for the drain)
```

The critical early-allow is evaluated **before** any per-target lookup, so a
critical event never queries per-sensor mute state and never reads the pause
deadline. Delivery *eligibility* is not the same as successful transport: an
eligible critical alarm still flows through the existing queue/retry path
(05-event-queue.md) when Telegram is offline.

## Suppression Matrix (per-recipient)

| Class | Legacy mute | Timed pause | Per-sensor pause | Quiet hours |
|-------|-------------|-------------|------------------|-------------|
| critical | bypass | bypass | bypass | bypass |
| warning | respect | respect | respect | **bypass** |
| info | respect | respect | respect | respect |
| routine motion | respect | respect | respect | respect |

- **Timed pause** is active only while `nonCriticalPausedUntil > clock.now()` — strict. At the exact deadline instant it is already inactive.
- **Legacy `muted = true`** is an indefinite pause until Resume clears it; critical still bypasses it. New indefinite global pauses can no longer be created — only 1/4/8-hour timed pauses (12-bot-cmd-mute.md).
- The matrix governs **per-recipient fan-out only**. The no-recipient broadcast fallback (mock/dev, or before the first user registers) broadcasts to the shared chat **without** evaluating mute, timed pause, per-sensor pause, quiet hours, or the pure policy.

## Automatic Notification Events

| Event | Recipients | Respects Quiet Hours |
|-------|-----------|---------------------|
| Sensor state change | All users (minus suppressed) | Info: yes. Warning: no. Critical: bypasses all |
| System start (full status) | All users | No |
| Motion event (snapshot + timecode) | All users (minus suppressed) | Routine (info): yes |
| Disk/sync warnings | Admins only | No |
| OTA update result | Admins only | No |
| Crash-loop detection | Admins only | No |
| External heartbeat failure | External service (not bot) | N/A |

## Debounce Logic

Configurable per sensor via `debounce_ms` field (default 10 000 ms from `DEFAULT_DEBOUNCE_MS`). Lives as an **application service** (`events/application/debounce.service.ts`) — not a free function and not in a driver.

```typescript
@Injectable()
export class DebounceService {
  private lastNotified = new Map<string, { value: unknown; at: number }>();

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(CLOCK)        private readonly clock: ClockPort,
  ) {}

  async shouldNotify(sensorId: string, newValue: unknown): Promise<boolean> {
    const last = this.lastNotified.get(sensorId);
    if (!last) return true;
    if (last.value !== newValue) return true;                       // real transition

    const sensor = await this.sensors.findById(sensorId);
    return this.clock.now().getTime() - last.at >= sensor.debounceMs;
  }
}
```

Key rules:
- Debounce suppresses repeated **identical** state changes (door OPEN→OPEN).
- Actual state transitions (OPEN→CLOSE) always delivered.
- Debounce is evaluated **only for non-critical** state changes. A critical alarm is never routed through `DebounceService` — a re-asserted identical critical value is always eligible and is never silently marked sent. Severity is resolved *before* the debounce gate so this ordering holds.
- Debounce still applies unchanged to `warning`, `info`, and routine motion.
- Critical-severity sensors can set `debounce=0`.
- Debounce is per-sensor, not per-user.
- Sensor lookup goes through `SensorQueryPort` — the notifications context never imports the sensors schema directly (../architecture.md → Anti-patterns).

## Quiet Hours Logic

Quiet hours live as a domain function in `events/domain/` (or `users/domain/` once that context exists) so they can be unit-tested without Nest.

```typescript
export function isInQuietHours(
  user: { quietStart: string | null; quietEnd: string | null },
  now: Date,                 // injected by caller; never new Date()
  timezone: string,
): boolean {
  if (!user.quietStart || !user.quietEnd) return false;

  const localMinutes = toLocalMinutes(now, timezone);
  const start = parseHHmm(user.quietStart);
  const end   = parseHHmm(user.quietEnd);

  return start > end
    ? (localMinutes >= start || localMinutes < end)   // overnight 23:00–07:00
    : (localMinutes >= start && localMinutes < end);  // same day 09:00–17:00
}
```

Callers pass `clock.now()` (from `ClockPort`) and `TIMEZONE`. DST handled by the timezone library (date-fns-tz). Critical events **always** bypass quiet hours.

## Notification Formats

### Sensor State Change
```
🚪 front_door: OPENED
```
```
💧 water_kitchen: TRIGGERED ⚠️
```
```
🌬️ co2_living: 950 ppm ⚠️ (warning threshold)
```

### System Start
```
📊 System Online | 08.04.2026 14:35

🚪 front_door: CLOSED
🚪 back_door: CLOSED
💧 water_kitchen: OK
💧 water_bathroom: OK
🌬️ co2_living: 620 ppm ✅

📡 All systems online
```

### System Going Offline
```
⚠️ System going offline | 08.04.2026 23:10
Reason: user restart
```

### Motion Event
Photo attachment with caption:
```
📹 Motion detected | front_door | 08.04.2026 12:51
```

### Disk Warning (admins)
```
⚠️ Disk usage at 72% (21.0 GB / 29.1 GB)
Consider cleaning up motion files.
```

### Disk Emergency (admins)
```
🚨 Disk usage at 96%!
Emergency cleanup triggered: pruned old logs and sent events.
Motion daemon stopped to prevent further writes.
```

### OTA Update Result (admins)
```
✅ Update complete | abc1234
```
or
```
❌ Update failed, rolled back to previous version.
```

## Offline Event Aggregation

See 05-event-queue.md for details. Summary format:

```
📋 Offline events (05.04.2026 14:00 — 08.04.2026 09:30):

05.04.2026 14:23 — door_1 OPENED
05.04.2026 14:24 — water_1 TRIGGERED ⚠️
05.04.2026 14:25 — door_1 CLOSED
06.04.2026 08:00 — CO2 peak 1450ppm
... (12 more events)
```

If > 100 events: send as file attachment.

## Error Handling

- If sending to one user fails (e.g., user blocked bot): log via Nest `Logger` at `warn`, continue to next user, don't retry indefinitely.
- If the notifier (Telegram) is down: events stay in queue, drain on reconnect.
- Never crash the process over a notification failure (see ../error-handling.md → Crash policy).

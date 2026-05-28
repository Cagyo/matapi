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
       ├─ Get all users
       ├─ For each user:
       │   ├─ Check: is sensor muted for this user? → skip
       │   ├─ Check: is user globally muted? → skip
       │   ├─ Check: quiet hours active AND severity = info? → skip
       │   ├─ Check: debounce (same sensor, same state, within window)? → skip
       │   └─ Send message
       │
       ▼
Mark event sent_at in DB
```

## Automatic Notification Events

| Event | Recipients | Respects Quiet Hours |
|-------|-----------|---------------------|
| Sensor state change | All users (minus muted) | Info: yes. Warning/Critical: no |
| System start (full status) | All users | No |
| Motion event (snapshot + timecode) | All users (minus muted) | Info: yes. Warning/Critical: no |
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

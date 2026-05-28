# 12 — /mute, /unmute, /quiet_hours Commands

## Dependencies
- 06-bot-core.md (bot instance)
- 01-database.md (users table, user_sensor_mutes table)

---

## /mute <sensor_name>

### Access
All users

### Syntax
```
/mute <sensor_name>
```

### Behavior
1. Validate sensor exists
2. Insert into `user_sensor_mutes` (userId, sensorId)
3. If already muted, inform

### Output
```
🔇 Notifications muted for door_1.
```

### Error Cases
| Condition | Response |
|-----------|----------|
| Sensor not found | "❌ Sensor 'xyz' not found" |
| Already muted | "ℹ️ door_1 is already muted" |

---

## /unmute <sensor_name>

### Access
All users

### Syntax
```
/unmute <sensor_name>
```

### Behavior
1. Validate sensor exists
2. Delete from `user_sensor_mutes`
3. If not muted, inform

### Output
```
🔔 Notifications enabled for door_1.
```

### Error Cases
| Condition | Response |
|-----------|----------|
| Sensor not found | "❌ Sensor 'xyz' not found" |
| Not muted | "ℹ️ door_1 is not muted" |

---

## /quiet_hours

### Access
All users

### Syntax
```
/quiet_hours HH:MM-HH:MM
/quiet_hours off
```

### Behavior

**Set quiet hours:**
1. Parse start and end times (24-hour format)
2. Store in `users.quietStart` and `users.quietEnd`
3. During quiet hours, **info** severity events are suppressed. **Warning** and **critical** events always delivered.

**Disable:**
1. Set `users.quietStart` and `users.quietEnd` to null

### Timezone
Quiet hours evaluated in local time (`TIMEZONE` env var, default `Europe/Kyiv`). DST transitions handled automatically.

### Output
```
🌙 Quiet hours set: 23:00 — 07:00
Info notifications suppressed. Critical alerts still delivered.
```

```
☀️ Quiet hours disabled.
```

### Error Cases
| Condition | Response |
|-----------|----------|
| Invalid format | "❌ Use format: /quiet_hours HH:MM-HH:MM (e.g., 23:00-07:00)" |
| Invalid time values | "❌ Invalid time. Use 24-hour format (00:00-23:59)" |

### Notes
- Overnight spans (23:00-07:00) work correctly — handled as "start > end means crosses midnight"
- Per-user setting, not global

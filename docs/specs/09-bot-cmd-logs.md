# 09 — /logs Command

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (sensor_logs table, sensors table, sensors_archive table)

## Access
All users

## Syntax
```
/logs <sensor_name> [count]
/logs <sensor_name> --since <duration>
```

- `count` defaults to 20
- `duration` format: `30m`, `2h`, `1d`, `7d`

## Behavior

Query `sensor_logs` table for matching sensor, ordered by timestamp descending.

### Name Resolution
1. Look up `sensor_name` in `sensors` table
2. If not found, look up in `sensors_archive` table
3. If found in either, use the `id` to query logs

## Output Format

```
📋 Logs for door_1 (last 20):

08.04.2026 14:23:05 [INFO] State changed: CLOSED → OPEN
08.04.2026 14:23:15 [INFO] State changed: OPEN → CLOSED
08.04.2026 12:01:00 [WARN] Debounce triggered (3 events in 1s)
...
```

- Timestamps in `DATETIME_FORMAT` + seconds
- Level shown as tag: `[DEBUG]`, `[INFO]`, `[WARN]`, `[ERROR]`

## Large Output

If output exceeds 4096 characters (Telegram message limit):
- Send as a `.txt` file attachment instead of inline message
- File named: `logs_<sensor_name>_<date>.txt`

## Error Cases

| Condition | Response |
|-----------|----------|
| Sensor not found (active or archived) | "❌ Sensor 'xyz' not found" |
| No logs found | "No logs for sensor 'xyz'" |
| Invalid duration format | "❌ Invalid duration format. Use: 30m, 2h, 1d, 7d" |
| Invalid count (negative, zero, non-number) | "❌ Invalid count. Use a positive number." |
| DB read error | "❌ Failed to read logs" |

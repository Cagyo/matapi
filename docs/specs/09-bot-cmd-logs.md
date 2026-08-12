# 09 — /logs Command

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (sensor_logs table, sensors table, sensors_archive table)

## Access

- Sensor logs: all registered users
- Application logs: administrators only

## Syntax
```
/logs <sensor_name> [count]
/logs <sensor_name> --since <duration>
/logs sensor <sensor_name> [count]
/logs sensor <sensor_name> --since <duration>
/logs app
/logs error
```

- `count` defaults to 20
- `duration` format: `30m`, `2h`, `1d`, `7d`
- `sensor` is the explicit escape for sensors named `app` or `error`
- `app` and `error` are reserved application-log forms and accept no extra arguments

## Behavior

Query `sensor_logs` table for matching sensor, ordered by timestamp descending.

The explicit `/logs sensor ...` form removes only the leading `sensor` token,
then uses the same name resolution, argument parsing, access permissions, and
delivery behavior as the existing sensor form. This does not change sensor-log
access or output.

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

## Application logs

`/logs app` returns the configured worker's application output stream and
`/logs error` returns its error stream. The streams are read and delivered
separately; they are never merged.

- The reader returns at most the latest 200 lines and reads at most 2 MiB.
- A successful request always sends a localized `.txt` document, including
  when the selected stream is empty.
- If the 2 MiB limit omits older lines, the document includes a localized
  truncation notice.
- A reader or presentation failure returns only the localized application-log
  unavailable response. Raw errors, file paths, log contents, and document
  bytes are never copied into replies or operational logs.
- Application forms authorize the current user before beginning a workflow or
  accessing PM2. Non-admins receive the localized admin-required response.
- Application forms do not accept counts, durations, custom process names, or
  custom paths. Extra arguments receive the localized invalid-arguments
  response and never fall through to sensor lookup.

## Contextual workflow return

Logs begins a receipt-bound `logs` workflow whose direct-command natural parent
is History. Sensor-picker selections use `logs:<receipt-id>:s:<selector>`;
the selector is opaque and never exposes the sensor identifier. `wr:<id>:o`
and `wr:<id>:h` are the separate Origin and Home navigation controls. The exact
receipt ID prevents stale picker buttons from affecting a later logs workflow.
Origin return discards only the matching cancellable picker draft; Home does the
same while opening Home. Result delivery comes before restoration, and an
already returned running job sends its result without moving the newer Home.
Application-log documents use the same receipt-bound completion path. A launch
from Home re-authorizes the current user and reuses Home's supplied receipt
without beginning a second workflow. Delivery failure recovery belongs to the
existing History navigation path and does not retry the document send.

## Error Cases

| Condition | Response |
|-----------|----------|
| Sensor not found (active or archived) | "❌ Sensor 'xyz' not found" |
| No logs found | "No logs for sensor 'xyz'" |
| Invalid duration format | "❌ Invalid duration format. Use: 30m, 2h, 1d, 7d" |
| Invalid count (negative, zero, non-number) | "❌ Invalid count. Use a positive number." |
| DB read error | "❌ Failed to read logs" |

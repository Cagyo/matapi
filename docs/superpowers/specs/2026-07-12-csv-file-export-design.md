# CSV File Export for Telegram — Design

## Goal

Let any registered Telegram user export the recent history of a configured sensor as a spreadsheet-ready CSV document. The feature is available through `/csv`, its `/export_csv` alias, and the interactive `/menu` dashboard. It supports current, disabled, and archived sensors without conflating sensors that reuse a name.

This design deliberately omits time-window syntax. The only command forms are:

```text
/csv
/csv <sensor_name> [count]
/export_csv <sensor_name> [count]
```

`count` defaults to 1,000 and must be an integer in `1..5,000`.

## Scope and Constraints

- Registered users may export the same sensor history they can already inspect with `/logs`.
- The feature does not change the database schema and does not add a migration.
- A history read is always capped at 5,000 rows; the repository limit remains required.
- Generated documents are capped at 8 MiB, including the UTF-8 BOM, header, quoted fields, and line endings. The cap is intentionally conservative relative to the worker's 512 MiB PM2 ceiling.
- Exports preserve complete stored messages. An oversized export fails; it is never truncated or partially delivered.
- All user-facing text belongs in `src/locales/en.ts`.

## Architecture

### Sensor application reads

Add two focused use cases under `src/sensors/application/`:

1. `ListSensorHistoryTargetsUseCase` lists selectable sensors.
2. `ReadSensorLogHistoryUseCase` resolves a selected sensor and reads its bounded log history.

Both depend on sensor-domain ports, not Drizzle. The Telegram context consumes these use cases instead of directly injecting a sensor repository.

Extend `SensorQueryPort` with a history-target projection that contains the immutable sensor ID, name, type, state (`current` or `archived`), and archived timestamp when applicable. It includes enabled and disabled current sensors, followed by archives. The Drizzle and in-memory adapters return targets in deterministic order: current first, then archived; alphabetical by name within each group; ID as the final tie-breaker. `ArchivedSensor` must retain `type` so its picker entry has the normal sensor icon.

`ReadSensorLogHistoryUseCase` accepts either a typed name or an immutable ID. Typed-name resolution follows the established active-first behavior. When a current and archived sensor share a name, the command exports the current sensor; the archive is selected through the keyboard. The use case exposes an export row projection that retains database row ID and a nullable timestamp. It orders SQL rows by `timestamp DESC, id DESC`; the CSV formatter emits the result in reverse order, producing stable oldest-to-newest output.

Malformed historical timestamps are not converted to the epoch. If an export row has no valid timestamp, the use case fails with a typed error that the Telegram handler maps to a safe localized export failure.

### CSV staging

CSV creation is a Telegram-context application concern with a narrow temp-file port and a Node infrastructure adapter. The formatter yields UTF-8 chunks; the temp-file adapter writes them to a private worker-owned directory, counts bytes exactly, and stops at 8 MiB. It removes the incomplete file on overflow or write failure.

The staging result exposes a source factory for upload. The handler sends `InputFile` using a fresh `createReadStream` for each attempt, then disposes the temporary file in `finally`. This permits grammY retries without reusing a consumed stream. At initialization, the adapter removes stale files in its own export directory older than one hour, covering interrupted processes without touching unrelated temporary files.

The source factory approach is supported by grammY's `InputFile` API, which accepts paths, readable streams, async iterators, and functions that create a source.

### Timezone configuration

Extract the current `TIMEZONE || 'Europe/Kyiv'` resolution into one injected cross-context timezone option. Events and Telegram CSV formatting both consume it; handlers do not read the environment directly. Local CSV timestamps use `date-fns-tz` `formatInTimeZone` and include the numeric offset, making DST fall-back hours unambiguous.

## Telegram UX

### Commands

- `/csv` with no argument renders a sensor picker.
- `/csv <name> [count]` and `/export_csv <name> [count]` export directly.
- Extra tokens, zero, negative values, non-integers, and values over 5,000 return `en.csv.invalidCount`.
- An unknown typed name replies with `en.csv.notFound(name)` and immediately renders the picker.
- A sensor with no rows returns `en.csv.none(name)`.

Register `csv` in the Bot API command descriptor. The alias remains callable but is not separately advertised.

### Picker and callbacks

Picker entries use immutable IDs:

```text
csv:select:<sensor-id>
csv:page:<origin>:<page>
```

`origin` is `command` or `menu`. Each page contains at most 20 targets. Archived labels have the form `🗄️ <name> (archived)`; current labels use the existing type icon. Menu-originated pages append `« Back to Dashboard` on a dedicated final row using the existing `menu:top` callback. Command-originated pages do not show that button.

On a selection callback, the handler answers the callback and acquires an in-flight lock keyed by chat and picker message. It then removes the inline markup before starting the export. A concurrent selection from the same message gets a harmless in-progress response instead of a duplicate document. Page navigation only edits the keyboard; it does not clear it.

Every callback validates its complete data shape before querying. A deleted sensor, a stale page, or an invalid callback receives a localized not-found/error reply rather than trusting callback text.

The menu adds `📈 Export CSV` both to the top-level dashboard and the Sensors submenu. `MenuHandler` delegates to `CsvHandler` with `origin: 'menu'`; it does not duplicate CSV logic.

### Delivery and recovery

The handler sends an upload-document chat action, stages the CSV, and replies with a document caption. File names include the safe sensor name, a short sensor-ID suffix, and the UTC generation timestamp, so active/archive duplicates are distinguishable.

If staging, reading, or delivery fails, the handler logs the full error with Nest `Logger`, replies with a locale-safe failure message, and renders a fresh picker. The old picker remains cleared. The temporary file is always disposed after the send attempt; a successful but unacknowledged Telegram response may still result in a user-initiated retry and therefore a duplicate document, which is an unavoidable delivery ambiguity rather than a data mutation.

## CSV Contract

The document begins with a UTF-8 BOM for Excel compatibility and uses RFC 4180 CRLF rows:

```csv
timestamp_utc,timestamp_local,sensor_name,level,value,message
```

- `timestamp_utc`: ISO-8601 UTC, for example `2030-01-01T12:34:56.000Z`.
- `timestamp_local`: configured IANA timezone including offset, for example `2030-01-01 14:34:56 +02:00`.
- `sensor_name`: resolved sensor name.
- `level`: the stored log level.
- `value`: a numeric spreadsheet value or empty field.
- `message`: the unmodified log message except for spreadsheet formula protection.

Every text field is RFC 4180 escaped. If a text field begins, after spaces, tabs, CR, or LF, with `=`, `+`, `-`, or `@`, the exporter prefixes it with a single apostrophe before CSV quoting. This preserves text semantics while preventing a spreadsheet formula from executing.

`value` is intentionally migration-free and conservative:

- `ppm=<number>` produces that numeric value.
- Known digital `State changed: … → …` destination labels map to their boolean value for every current step type: contact, leak hazard, alarm, power, motion, and button.
- Any other log message produces an empty `value` field.

This parser is tied to the currently persisted English log vocabulary. Tests enumerate every supported label pair; changing that vocabulary requires intentionally updating the parser. A future schema migration to store structured readings may replace the parser.

## Errors and Locales

Add `en.csv` keys for picker title, caption, empty result, file name, not-found, invalid count, malformed history, too-large, in-progress, and generic export failure. Add `/csv` to the user command list and add the two menu labels. Do not add duration parsing or duration locale keys.

## Verification

### Unit and use-case tests

- Count parsing: defaults, boundary values, alias, extra arguments, and invalid input.
- Current, disabled, archived, and duplicate-name target ordering; active-first direct resolution and ID-based archive selection.
- Stable equal-timestamp ordering and corrupt/missing timestamp failure.
- Six-column chronological output, BOM, CRLF, RFC 4180 quoting, non-ASCII text, formula prefixes, and all supported numeric/binary value forms.
- DST fall-back output includes distinct offsets.
- 8 MiB limit includes header, BOM, escaping, and multibyte input; overflow never leaves a file.
- Picker pagination, menu context propagation, stale/invalid callbacks, callback markup cleanup, and concurrent-selection lock.
- No-log, unknown sensor, malformed history, read failure, staging failure, and upload failure each produce the correct locale reply and a fresh retry picker when applicable.

### Infrastructure and regression tests

- Drizzle query returns current/archive targets and uses `timestamp DESC, id DESC` for export rows.
- The temp-file adapter cleans success, failure, overflow, and stale-file paths; its upload source factory opens a fresh stream on each call.
- `MenuHandler` delegates both CSV entry points without duplicating behavior.
- Run the focused test suites, then `yarn test` and `yarn build`.

## Documentation Maintenance

Update `docs/ports-and-adapters.md` for the expanded sensor-query surface and the Telegram CSV temp-file port/adapter.

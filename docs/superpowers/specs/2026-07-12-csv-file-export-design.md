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
- The export reader is streaming and rejects any selected log row whose UTF-8 message is larger than 256 KiB before yielding it. This bounds a single malformed row without altering stored history.
- Generated documents are capped at 8 MiB, including the UTF-8 BOM, header, quoted fields, and line endings. The cap is intentionally conservative relative to the worker's 512 MiB PM2 ceiling.
- Exports preserve complete stored messages. An oversized export fails; it is never truncated or partially delivered.
- All user-facing text belongs in `src/locales/en.ts`.

## Architecture

### Sensor application reads

Add two focused use cases under `src/sensors/application/`:

1. `ListSensorHistoryTargetsUseCase` lists selectable sensors.
2. `ReadSensorLogHistoryUseCase` resolves a selected sensor and reads its bounded log history.

Both depend on sensor-domain ports, not Drizzle. The Telegram context consumes these use cases instead of directly injecting a sensor repository.

Extend `SensorQueryPort` with a paged history-target projection containing the immutable sensor ID, name, type, enabled state, state (`current` or `archived`), and archived timestamp when applicable. It includes enabled and disabled current sensors, followed by archives. The port accepts `{ page, pageSize }` and returns `{ targets, page, pageCount }`; Drizzle applies limit/offset in SQL rather than loading the archive into memory. Ordering is current first, then archived; within each group SQLite uses `name COLLATE NOCASE, id`. `ArchivedSensor` must retain `type` so its picker entry has the normal sensor icon.

`ReadSensorLogHistoryUseCase` accepts either a typed name or an immutable ID. Typed-name resolution follows the established active-first behavior. When a current and archived sensor share a name, the command exports the current sensor; the archive is selected through the keyboard. The use case consumes `SensorLogExportReaderPort`, a streaming read port owned by the sensors application. Its synchronous `withRows(sensorId, { limit, maxMessageBytes }, consume)` method invokes a `void`-returning consumer while the read snapshot is open; promise-returning consumers are rejected. `SensorLogExportRow` has `{ id, level, message, timestamp: Date | null }` and no Drizzle type leaks across the boundary.

The Drizzle adapter opens one synchronous read transaction, selects the newest matching `limit` rows by `timestamp DESC, id DESC`, validates that selected set's maximum UTF-8 message byte length, and then supplies an iterator over that same set by `timestamp ASC, id ASC` to `consume`. The consumer writes synchronously while the callback runs, then uploads only after the transaction closes. This avoids loading all 5,000 messages into application memory, avoids a preflight/stream race, and emits CSV rows in stable oldest-to-newest order without a reverse copy. The in-memory adapter implements the same cap and ordering semantics.

Malformed historical timestamps are not converted to the epoch. If an export row has no valid timestamp, the use case fails with a typed error that the Telegram handler maps to a safe localized export failure.

### CSV staging

`CsvTempFilePort` lives at `src/telegram/application/ports/csv-temp-file.port.ts`; it is consumed by the Telegram application use case that stages formatter chunks. `NodeCsvTempFileAdapter` lives in `src/telegram/infrastructure/` and is bound to the port token by `TelegramModule`.

The formatter yields UTF-8 chunks; the temp-file adapter writes them to a private worker-owned directory, counts bytes exactly, and stops at 8 MiB. It removes the incomplete file on overflow or write failure. The directory is created with mode `0700`; each uniquely created regular file uses mode `0600`. Cleanup only traverses this owned directory, rejects symlinks, and deletes only feature-owned regular files older than one hour.

The staging result exposes a source factory for upload. The handler sends `InputFile` using a fresh `createReadStream` for each attempt, then disposes the temporary file in `finally`. This permits grammY retries without reusing a consumed stream. At initialization, the adapter removes stale files in its own export directory older than one hour, covering interrupted processes without touching unrelated temporary files.

The source factory approach is supported by grammY's `InputFile` API, which accepts paths, readable streams, async iterators, and functions that create a source.

### Timezone configuration

Create a non-global `ConfigModule` that exports `TIMEZONE_OPTIONS` from `src/config/application/ports/timezone-options.port.ts`. Its `TimezoneOptions` contract contains the resolved IANA timezone; its factory applies `TIMEZONE || 'Europe/Kyiv'`. `EventModule` and `TelegramModule` explicitly import `ConfigModule`. Events retains its notification-specific options but receives the shared timezone through this token; Telegram CSV formatting uses the same token. Handlers do not read the environment directly. Local CSV timestamps use `date-fns-tz` `formatInTimeZone` and include the numeric offset, making DST fall-back hours unambiguous.

## Telegram UX

### Commands

- `/csv` with no argument renders a sensor picker.
- `/csv <name> [count]` and `/export_csv <name> [count]` export directly.
- Extra tokens, zero, negative values, non-integers, and values over 5,000 return `en.csv.invalidCount`.
- An unknown typed name replies with `en.csv.notFound(name)` and immediately renders the picker.
- A sensor with no rows returns `en.csv.none(name)`.

Register `csv` in the Bot API command descriptor. The alias remains callable but is not separately advertised.

### Picker and callbacks

Picker entries use short, verified selection references:

```text
csv:select:<origin>:<page>:<index>:<id-hash>
csv:page:<origin>:<page>
```

`origin` is `command` or `menu`. Each page contains at most 20 targets. The handler reloads the requested page, validates `index`, and compares `id-hash` to the first 12 base64url characters of SHA-256 over the server-side target ID before passing that immutable ID to the export use case. This stays within Telegram's 64-byte callback limit even for legacy IDs. Archived labels have the form `🗄️ <name> (archived)` and disabled current labels have the form `⏸️ <name> (disabled)`; other current labels use the existing type icon. Menu-originated pages append `« Back to Dashboard` on a dedicated final row using the existing `menu:top` callback. Command-originated pages do not show that button.

Page numbers are zero-based. A page callback is valid only when its origin is known and its page is a non-negative integer. The handler rebuilds target metadata on every page request, clamps a now-out-of-range page to the final available page, and shows the empty-picker response when no targets remain. A target that disappears after rendering produces the normal not-found response.

On a selection callback, the handler answers the callback and acquires an in-flight lock keyed by chat and picker message. It then removes the inline markup before starting the export. A concurrent selection from the same message gets a harmless in-progress response instead of a duplicate document. The lock releases only in `finally`; a hung consumed picker remains unavailable, while the user can start a fresh picker with `/csv`. Page navigation only edits the keyboard; it does not clear it.

Every callback validates its complete data shape before querying. A deleted sensor, a stale page, or an invalid callback receives a localized not-found/error reply rather than trusting callback text.

The menu adds `📈 Export CSV` both to the top-level dashboard and the Sensors submenu. `MenuHandler` delegates to `CsvHandler` with `origin: 'menu'`; it does not duplicate CSV logic.

### Delivery and recovery

The handler sends an upload-document chat action, stages the CSV, and replies with a document caption. File names are `csv_<sensor-name>_<id-first-8>_<YYYYMMDDTHHmmssZ>.csv`, so active/archive duplicates are distinguishable.

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
- Only messages matching the complete case-insensitive grammar `State changed: <old> → <destination>` are eligible for digital parsing. Their normalized destination labels map as follows: `CLOSED → 0`, `OPEN`/`OPENED → 1`, `DRY → 0`, `LEAK DETECTED → 1`, `NORMAL → 0`, `ALARM → 1`, `GRID OK → 0`, `OUTAGE → 1`, `CLEAR → 0`, `MOTION → 1`, `RELEASED → 0`, and `PRESSED → 1`.
- Any other log message produces an empty `value` field.

This parser is tied to the currently persisted English log vocabulary. Tests enumerate every supported label pair; changing that vocabulary requires intentionally updating the parser. A future schema migration to store structured readings may replace the parser.

## Errors and Locales

Add `en.csv` keys for picker title, caption, empty result, file name, not-found, invalid count, malformed history, too-large, in-progress, and generic export failure. Add `/csv` to the user command list and add the two menu labels. Do not add duration parsing or duration locale keys.

## Verification

### Unit and use-case tests

- Count parsing: defaults, boundary values, alias, extra arguments, and invalid input.
- Current, disabled, archived, and duplicate-name target ordering; case-insensitive sort; active-first direct resolution; target-page SQL bounds; and verified short selection references.
- Stable equal-timestamp ordering, raw timestamp unit conversion, and corrupt/missing timestamp failure.
- Six-column chronological output, BOM, CRLF, RFC 4180 quoting, non-ASCII text, formula prefixes, and all supported numeric/binary value forms.
- DST fall-back output includes distinct offsets.
- Streaming reader cap rejects a 256 KiB-plus message before yielding it; 8 MiB output accounting includes header, BOM, escaping, formula-prefix expansion, and multibyte input; overflow never leaves a file.
- Picker pagination, invalid/negative/out-of-range page callbacks, target disappearance, menu context propagation, callback markup cleanup, concurrent-selection lock, and release in `finally`.
- No-log, unknown sensor, malformed history, read failure, staging failure, and upload failure each produce the correct locale reply and a fresh retry picker when applicable.

### Infrastructure and regression tests

- Drizzle export reader uses one synchronous snapshot callback, selects the newest capped result set by `timestamp DESC, id DESC`, enforces the row-size cap before iterating it `timestamp ASC, id ASC`.
- The temp-file adapter enforces directory/file modes, rejects symlinks, and cleans success, failure, overflow, and stale-file paths; its upload source factory opens a fresh stream on each call. A Pi smoke test exports an 8 MiB fixture and records event-loop delay before accepting the synchronous staging budget.
- `MenuHandler` delegates both CSV entry points without duplicating behavior.
- Run the focused test suites, then `yarn test` and `yarn build`.

## Documentation Maintenance

Update `docs/ports-and-adapters.md` for the expanded sensor-query surface, the streaming export reader, `TIMEZONE_OPTIONS`, and the Telegram CSV temp-file port/adapter.

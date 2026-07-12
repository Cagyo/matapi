# Telegram CSV File Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let registered Telegram users export current, disabled, or archived sensor history as a spreadsheet-ready CSV through /csv, /export_csv, and /menu.

**Architecture:** Sensors supplies two application reads: one lists history targets and one resolves a target then invokes a synchronous bounded SQLite row-consumer callback. Telegram formats rows and stages a private temporary file behind an application port; grammY uploads a fresh read stream only after the SQLite snapshot closes. A non-global ConfigModule provides one injected timezone option to Events and Telegram.

**Tech Stack:** NestJS 10, TypeScript strict, better-sqlite3 11.7, Drizzle ORM 0.38, grammY 1.34, date-fns-tz 3.2, Vitest 2.

## Global Constraints

- Preserve hexagonal boundaries: interfaces invoke application use cases; application depends on ports; infrastructure implements ports.
- No schema or migration changes. Do not edit migrations manually.
- Default export count is 1000; the maximum is 5000; one source message may be at most 256 KiB UTF-8; the completed document may be at most 8 MiB.
- The selected rows are the newest requested rows; CSV emits them oldest-to-newest with sensor_logs.id as the timestamp tie-breaker.
- CSV has a UTF-8 BOM, RFC 4180 CRLF records, formula-prefix protection, and configured IANA timezone with offset.
- All user copy belongs in src/locales/en.ts. Production paths use Nest Logger and never console logging.
- The Pi process has a 512 MiB PM2 ceiling. Do not materialize a 5000-row list or CSV Buffer.
- Private CSV storage uses directory mode 0700, file mode 0600, unique regular files only, and one-hour stale cleanup.
- Do not stage unrelated existing worktree changes.

---

## File Structure

| File | Responsibility |
|---|---|
| src/config/application/ports/timezone-options.port.ts | Shared TIMEZONE_OPTIONS token and type. |
| src/config/infrastructure/env-timezone-options.adapter.ts | Resolve TIMEZONE with Europe/Kyiv fallback. |
| src/config/config.module.ts | Explicitly export the shared timezone provider. |
| src/sensors/domain/ports/sensor-query.port.ts | SQL-paged history-target read model. |
| src/sensors/domain/ports/sensor-log-export-reader.port.ts | Snapshot callback contract and export row type. |
| src/sensors/application/list-sensor-history-targets.use-case.ts | Validated 20-item target pages. |
| src/sensors/application/read-sensor-log-history.use-case.ts | Active-first target resolution and reader delegation. |
| src/sensors/infrastructure/drizzle-sensor.query.ts | Deterministic current/archive targets. |
| src/sensors/infrastructure/in-memory-sensor.query.ts | In-memory target read model. |
| src/sensors/infrastructure/drizzle-sensor-log-export.reader.ts | Synchronous SQLite snapshot and iterator. |
| src/sensors/infrastructure/in-memory-sensor-log-export.reader.ts | In-memory snapshot equivalent. |
| src/telegram/application/ports/csv-temp-file.port.ts | Staged-file contract and token. |
| src/telegram/infrastructure/node-csv-temp-file.adapter.ts | Private file lifecycle and exact byte limit. |
| src/telegram/application/csv-export.formatter.ts | Pure CSV rows, value mapping, escaping, filename. |
| src/telegram/application/stage-csv-export.use-case.ts | History reader, formatter, timezone, and staging orchestration. |
| src/telegram/interfaces/csv.handler.ts | Commands, paging, locks, upload, and locale mapping. |
| src/telegram/interfaces/menu.handler.ts | Delegation of both CSV menu entries. |
| src/telegram/infrastructure/grammy-bot.gateway.ts | Handler registration. |
| src/sensors/sensor.module.ts, src/events/event.module.ts, src/telegram/telegram.module.ts | Provider wiring and exports. |
| src/locales/en.ts | Commands and CSV/menu copy. |
| test/config, test/sensors, test/telegram | Unit, application, infrastructure, and handler tests. |
| docs/ports-and-adapters.md | Living port/adapter catalogue. |

## Task 1: Share timezone configuration

**Files:**
- Create: src/config/application/ports/timezone-options.port.ts
- Create: src/config/infrastructure/env-timezone-options.adapter.ts
- Create: src/config/config.module.ts
- Create: test/config/infrastructure/env-timezone-options.adapter.test.ts
- Modify: src/events/event.module.ts
- Modify: src/telegram/telegram.module.ts

**Consumes:** none.

**Produces:** TIMEZONE_OPTIONS and TimezoneOptions, exported by ConfigModule and injected by Events and Telegram.

- [ ] **Step 1: Write the failing option-factory test**

~~~ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { timezoneOptionsFromEnv } from '../../../src/config/infrastructure/env-timezone-options.adapter';

describe('timezoneOptionsFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to Europe/Kyiv', () => {
    vi.stubEnv('TIMEZONE', '');
    expect(timezoneOptionsFromEnv()).toEqual({ timezone: 'Europe/Kyiv' });
  });

  it('keeps an explicit IANA timezone', () => {
    vi.stubEnv('TIMEZONE', 'America/New_York');
    expect(timezoneOptionsFromEnv()).toEqual({ timezone: 'America/New_York' });
  });
});
~~~

- [ ] **Step 2: Run the test to verify it fails**

Run: yarn test test/config/infrastructure/env-timezone-options.adapter.test.ts

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the option and module**

~~~ts
// timezone-options.port.ts
export const TIMEZONE_OPTIONS = Symbol('TIMEZONE_OPTIONS');
export interface TimezoneOptions { readonly timezone: string; }

// env-timezone-options.adapter.ts
export function timezoneOptionsFromEnv(): TimezoneOptions {
  return { timezone: process.env.TIMEZONE || 'Europe/Kyiv' };
}

// config.module.ts
@Module({
  providers: [{ provide: TIMEZONE_OPTIONS, useFactory: timezoneOptionsFromEnv }],
  exports: [TIMEZONE_OPTIONS],
})
export class ConfigModule {}
~~~

Import ConfigModule in EventModule and TelegramModule. Inject TIMEZONE_OPTIONS into the NOTIFICATION_OPTIONS factory and set timezone from the injected value; remove that direct TIMEZONE environment read.

- [ ] **Step 4: Verify focused behavior**

Run: yarn test test/config/infrastructure/env-timezone-options.adapter.test.ts test/events/application/notification.service.test.ts && yarn build

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/config src/events/event.module.ts src/telegram/telegram.module.ts test/config
git commit -m "feat(config): share timezone options"
~~~

## Task 2: Add deterministic sensor history targets

**Files:**
- Modify: src/sensors/domain/ports/sensor-query.port.ts
- Modify: src/sensors/infrastructure/drizzle-sensor.query.ts
- Modify: src/sensors/infrastructure/in-memory-sensor.query.ts
- Create: src/sensors/application/list-sensor-history-targets.use-case.ts
- Modify: src/sensors/sensor.module.ts
- Modify: test/sensors/infrastructure/drizzle-sensor.query.test.ts
- Create: test/sensors/application/list-sensor-history-targets.use-case.test.ts

**Consumes:** SENSOR_QUERY.

**Produces:** SensorHistoryTarget, SensorHistoryPage, and ListSensorHistoryTargetsUseCase.

- [ ] **Step 1: Write failing target-order/page tests**

~~~ts
it('returns current sensors before archives, ordered by name then id', async () => {
  await expect(useCase.execute({ page: 0, pageSize: 20 })).resolves.toMatchObject({
    page: 0,
    targets: [
      { id: 'a-disabled', state: 'current' },
      { id: 'z-current', state: 'current' },
      { id: 'a-archive', state: 'archived' },
    ],
  });
});

it('clamps a stale page to the final available page', async () => {
  await expect(useCase.execute({ page: 99, pageSize: 2 })).resolves.toMatchObject({
    page: 1,
    pageCount: 2,
  });
});
~~~

- [ ] **Step 2: Run tests to verify failure**

Run: yarn test test/sensors/application/list-sensor-history-targets.use-case.test.ts test/sensors/infrastructure/drizzle-sensor.query.test.ts

Expected: FAIL because the target contract and use case do not exist.

- [ ] **Step 3: Implement the query surface**

~~~ts
export interface SensorHistoryTarget {
  readonly id: string;
  readonly name: string;
  readonly type: SensorType;
  readonly enabled: boolean;
  readonly state: 'current' | 'archived';
  readonly archivedAt: Date | null;
}

export interface SensorQueryPort {
  // preserve existing methods
  listHistoryTargets(input: { page: number; pageSize: number }): Promise<SensorHistoryPage>;
}

export interface SensorHistoryPage {
  readonly targets: readonly SensorHistoryTarget[];
  readonly page: number;
  readonly pageCount: number;
}
~~~

Implement listHistoryTargets with one SQL-paged UNION ALL query and a total-count query. Order by state rank, name COLLATE NOCASE, and id; apply LIMIT/OFFSET in SQL instead of loading all archives to slice. Include disabled current rows and archived type. The in-memory adapter copies, case-insensitively sorts, and then slices. The use case rejects negative/non-integer pages and non-positive page sizes; for an empty list it returns page 0 and pageCount 0, otherwise it uses the returned page metadata.

- [ ] **Step 4: Verify focused behavior**

Run: yarn test test/sensors/application/list-sensor-history-targets.use-case.test.ts test/sensors/infrastructure/drizzle-sensor.query.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/sensors test/sensors
git commit -m "feat(sensors): list export history targets"
~~~

## Task 3: Read export history in one bounded SQLite snapshot

**Files:**
- Create: src/sensors/domain/ports/sensor-log-export-reader.port.ts
- Create: src/sensors/domain/errors/sensor-log-export-row-too-large.error.ts
- Create: src/sensors/domain/errors/malformed-sensor-log-timestamp.error.ts
- Create: src/sensors/infrastructure/drizzle-sensor-log-export.reader.ts
- Create: src/sensors/infrastructure/in-memory-sensor-log-export.reader.ts
- Create: src/sensors/application/read-sensor-log-history.use-case.ts
- Modify: src/sensors/sensor.module.ts
- Create: test/sensors/infrastructure/drizzle-sensor-log-export.reader.test.ts
- Create: test/sensors/application/read-sensor-log-history.use-case.test.ts

**Consumes:** SQLITE, SENSOR_QUERY, SENSOR_LOG_EXPORT_READER.

**Produces:** SensorLogExportReaderPort, typed snapshot errors, and ReadSensorLogHistoryUseCase.

- [ ] **Step 1: Write failing snapshot-reader tests**

~~~ts
it('selects the newest limit rows but consumes those rows oldest first with id ties', () => {
  const ids: number[] = [];
  reader.withRows('s1', { limit: 2, maxMessageBytes: 256 * 1024 }, (rows) => {
    for (const row of rows) ids.push(row.id);
  });
  expect(ids).toEqual([2, 3]);
});

it('rejects an oversized selected row before invoking the consumer', () => {
  expect(() => reader.withRows('s1', { limit: 1, maxMessageBytes: 4 }, () => undefined))
    .toThrow(SensorLogExportRowTooLargeError);
});
~~~

- [ ] **Step 2: Run tests to verify failure**

Run: yarn test test/sensors/infrastructure/drizzle-sensor-log-export.reader.test.ts test/sensors/application/read-sensor-log-history.use-case.test.ts

Expected: FAIL because the reader port and errors do not exist.

- [ ] **Step 3: Implement the synchronous reader contract**

~~~ts
export const SENSOR_LOG_EXPORT_READER = Symbol('SENSOR_LOG_EXPORT_READER');

export interface SensorLogExportRow {
  readonly id: number;
  readonly level: SensorLogLevel;
  readonly message: string;
  readonly timestamp: Date | null;
}

export interface SensorLogExportReaderPort {
  withRows(
    sensorId: string,
    options: { limit: number; maxMessageBytes: number },
    consume: (rows: Iterable<SensorLogExportRow>) => void,
  ): void;
}
~~~

Inject SQLITE, not DB, into the Drizzle adapter. Use sqlite.transaction with no async work inside its callback. Both statements use the same CTE: select the newest limit rows by timestamp DESC, id DESC. First query max(length(CAST(message AS BLOB))) and count null timestamps; throw SensorLogExportRowTooLargeError or MalformedSensorLogTimestampError before consuming. Then use preparedStatement.iterate(sensorId, limit) over that CTE ordered timestamp ASC, id ASC. Convert raw Unix-second timestamps with new Date(seconds * 1000). Call consume synchronously before the transaction returns.

ReadSensorLogHistoryUseCase resolves a name active-first through findByName or an ID through findByIdIncludingArchived, then calls the void-returning withRows callback. Reject a consumer result with a then function before the transaction exits. Export the use case and reader token from SensorModule. The in-memory reader follows the same newest-limit then ascending-output semantics. Add an integration assertion that a Date inserted through Drizzle returns at the identical millisecond from the raw reader.

- [ ] **Step 4: Verify reader and existing logs**

Run: yarn test test/sensors/infrastructure/drizzle-sensor-log-export.reader.test.ts test/sensors/application/read-sensor-log-history.use-case.test.ts test/sensors/infrastructure/drizzle-sensor-log.repository.test.ts

Expected: PASS; the existing /logs repository behavior is unchanged.

- [ ] **Step 5: Commit**

~~~bash
git add src/sensors test/sensors
git commit -m "feat(sensors): stream bounded export history"
~~~

## Task 4: Format and stage bounded CSV documents

**Files:**
- Create: src/telegram/application/ports/csv-temp-file.port.ts
- Create: src/telegram/infrastructure/node-csv-temp-file.adapter.ts
- Create: src/telegram/application/csv-export.formatter.ts
- Create: src/telegram/application/stage-csv-export.use-case.ts
- Modify: src/telegram/telegram.module.ts
- Create: test/telegram/application/csv-export.formatter.test.ts
- Create: test/telegram/application/stage-csv-export.use-case.test.ts
- Create: test/telegram/infrastructure/node-csv-temp-file.adapter.test.ts

**Consumes:** ReadSensorLogHistoryUseCase, TIMEZONE_OPTIONS, CSV_TEMP_FILE.

**Produces:** CsvTempFile and StageCsvExportUseCase.

- [ ] **Step 1: Write failing formatter/staging tests**

~~~ts
it('emits BOM, CRLF, formula-safe text, and binary values', () => {
  expect([...formatCsvRows(sensor, rows, 'Europe/Kyiv')].join('')).toBe(
    '\uFEFFtimestamp_utc,timestamp_local,sensor_name,level,value,message\r\n' +
    '2030-01-01T00:00:00.000Z,2030-01-01 02:00:00 +02:00,door,info,1,"\'=danger"\r\n',
  );
});

it('removes an incomplete file when output exceeds 8 MiB', async () => {
  expect(() => port.stage('x.csv', ['x'.repeat(8 * 1024 * 1024 + 1)]))
    .toThrow(CsvDocumentTooLargeError);
  await expect(readdir(tempDirectory)).resolves.toEqual([]);
});

it('creates private files and opens independent retry streams', async () => {
  const file = port.stage('x.csv', ['ok']);
  expect((await stat(tempDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(tempDirectory, file.filename)).mode & 0o777).toBe(0o600);
  expect(await readAll(file.open())).toEqual(await readAll(file.open()));
  await file.dispose();
});
~~~

- [ ] **Step 2: Run tests to verify failure**

Run: yarn test test/telegram/application/csv-export.formatter.test.ts test/telegram/application/stage-csv-export.use-case.test.ts test/telegram/infrastructure/node-csv-temp-file.adapter.test.ts

Expected: FAIL because formatter, port, and staging use case do not exist.

- [ ] **Step 3: Implement the formatter and private-file port**

~~~ts
export const CSV_TEMP_FILE = Symbol('CSV_TEMP_FILE');
export const MAX_CSV_BYTES = 8 * 1024 * 1024;

export interface CsvTempFile {
  readonly filename: string;
  open(): Readable;
  dispose(): Promise<void>;
}

export interface CsvTempFilePort {
  stage(filename: string, chunks: Iterable<string>): CsvTempFile;
  cleanupStale(now: Date): Promise<void>;
}
~~~

NodeCsvTempFileAdapter creates an owned directory with mode 0700. Stage creates a unique regular file with openSync(..., 'wx', 0o600), counts Buffer.byteLength(chunk, 'utf8'), writes with writeSync, and closes/unlinks before throwing on size or write failure. open returns createReadStream(path); dispose unlinks idempotently. OnModuleInit calls cleanupStale(new Date()), which only unlinks non-symlink regular files bearing the feature filename prefix and older than one hour.

formatCsvRows yields BOM/header first and then CRLF rows. Quote every text field by doubling quotes. Prefix one apostrophe when /^[ \t\r\n]*[=+\-@]/ matches. Parse ppm=<number> before state changes. Only parse a binary state when the complete message matches case-insensitive State changed: <old> → <destination>; map CLOSED, DRY, NORMAL, GRID OK, CLEAR, RELEASED to 0 and OPEN, OPENED, LEAK DETECTED, ALARM, OUTAGE, MOTION, PRESSED to 1. Output blank for every other message. Use formatInTimeZone(timestamp, timezone, 'yyyy-MM-dd HH:mm:ss XXX').

StageCsvExportUseCase calls ReadSensorLogHistoryUseCase with maxMessageBytes 256 * 1024 and stages formatter chunks inside its synchronous row consumer. Its filename is csv_<sensor-name>_<id-first-8>_<YYYYMMDDTHHmmssZ>.csv.

- [ ] **Step 4: Verify focused behavior**

Run: yarn test test/telegram/application/csv-export.formatter.test.ts test/telegram/application/stage-csv-export.use-case.test.ts test/telegram/infrastructure/node-csv-temp-file.adapter.test.ts

Expected: PASS, including non-ASCII/BOM, formula expansion, all known state labels, DST offset, cleanup, and exact-size cases.

- [ ] **Step 5: Commit**

~~~bash
git add src/telegram test/telegram
git commit -m "feat(telegram): stage bounded CSV exports"
~~~

## Task 5: Add commands, picker callbacks, and bot registration

**Files:**
- Create: src/telegram/interfaces/csv.handler.ts
- Modify: src/telegram/infrastructure/grammy-bot.gateway.ts
- Modify: src/telegram/telegram.module.ts
- Modify: src/locales/en.ts
- Create: test/telegram/interfaces/csv.handler.test.ts
- Create: test/telegram/infrastructure/grammy-bot.gateway.test.ts if no gateway test already exists

**Consumes:** ListSensorHistoryTargetsUseCase, StageCsvExportUseCase, RoleMiddleware.

**Produces:** CsvHandler.handleEmpty(ctx, origin, page), registered commands, and callbacks.

- [ ] **Step 1: Write failing handler tests**

~~~ts
it('registers both commands and CSV callbacks behind registered-user guard', () => {
  expect(composer.command).toHaveBeenCalledWith('csv', guard.registered, expect.anything());
  expect(composer.command).toHaveBeenCalledWith('export_csv', guard.registered, expect.anything());
  expect(composer.callbackQuery).toHaveBeenCalledWith(expect.any(RegExp), guard.registered, expect.anything());
});

it('resolves a verified short selector, clears markup, uploads, and disposes the file', async () => {
  await callback('csv:select:command:0:0:targetHash');
  expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: undefined });
  expect(stage.execute).toHaveBeenCalledWith({ target: { kind: 'id', id: 'current-id' }, count: 1000 });
  expect(file.dispose).toHaveBeenCalledOnce();
});
~~~

- [ ] **Step 2: Run the handler test to verify failure**

Run: yarn test test/telegram/interfaces/csv.handler.test.ts

Expected: FAIL because CsvHandler does not exist.

- [ ] **Step 3: Implement command and callback behavior**

~~~ts
const DEFAULT_CSV_COUNT = 1000;
const MAX_CSV_COUNT = 5000;
const PAGE_SIZE = 20;
type PickerOrigin = 'command' | 'menu';

function parseCsvArgs(raw: string): { name: string; count: number } | null {
  const [name, countToken, ...rest] = raw.trim().split(/\s+/).filter(Boolean);
  if (!name || rest.length > 0) return null;
  if (!countToken) return { name, count: DEFAULT_CSV_COUNT };
  if (!/^\d+$/.test(countToken)) return null;
  const count = Number(countToken);
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_CSV_COUNT
    ? { name, count }
    : null;
}
~~~

handleEmpty invokes the target-list use case with pageSize 20 and replies with the picker. Page callback data is csv:page:<command|menu>:<non-negative-integer>. Selection callback data is csv:select:<origin>:<page>:<index>:<hash>, where hash is the first 12 SHA-256 base64url characters of the target ID. Reload the requested SQL page, validate origin/index/hash, then pass the server-side immutable ID to staging. Assert every generated callback payload is at most 64 UTF-8 bytes. The handler returns the empty-picker copy when pageCount is zero.

On selection, key a Map lock by chat and picker message ID, answer the callback, clear markup, send upload_document chat action, await StageCsvExportUseCase.execute, and call replyWithDocument(new InputFile(() => file.open(), file.filename), { caption }). Always dispose and release the lock in finally; never expire an active lock because a fresh /csv picker remains available if an upload hangs. Map invalid count, not found, no rows, oversized row/file, malformed timestamp, in-progress, and generic failure to distinct en.csv keys. After a read/stage/upload failure, reply with the error and render a new picker with the original origin. Label disabled targets as ⏸️ <name> (disabled).

Add one user command descriptor named csv; the alias is callable but not advertised. Add en.csv keys and the two menu labels. Inject CsvHandler into GrammyBotGateway and include it in handlers before MenuHandler.

- [ ] **Step 4: Verify commands and gateway**

Run: yarn test test/telegram/interfaces/csv.handler.test.ts test/telegram/infrastructure/grammy-bot.gateway.test.ts

Expected: PASS. If the gateway test file did not exist, create a test asserting CsvHandler is registered exactly once.

- [ ] **Step 5: Commit**

~~~bash
git add src/telegram src/locales/en.ts test/telegram
git commit -m "feat(telegram): add CSV export command"
~~~

## Task 6: Add both menu entry points and update port documentation

**Files:**
- Modify: src/telegram/interfaces/menu.handler.ts
- Modify: test/telegram/interfaces/menu.handler.test.ts
- Modify: docs/ports-and-adapters.md

**Consumes:** CsvHandler.handleEmpty(ctx, 'menu').

**Produces:** Dashboard and Sensor Operations menu paths with no duplicate CSV logic.

- [ ] **Step 1: Write failing menu tests**

~~~ts
it('shows Export CSV in the dashboard and Sensors submenu', async () => {
  await commandCallbacks.menu(menuContext);
  expect(JSON.stringify(reply.mock.calls[0][1].reply_markup)).toContain('menu:sub:csv');

  await menuCallback(sensorSubmenuContext);
  expect(JSON.stringify(editMessageText.mock.calls.at(-1)?.[1].reply_markup)).toContain('menu:sub:csv');
});

it('delegates the CSV submenu with menu origin', async () => {
  await menuCallback(csvSubmenuContext);
  expect(csvHandler.handleEmpty).toHaveBeenCalledWith(csvSubmenuContext, 'menu');
});
~~~

- [ ] **Step 2: Run menu tests to verify failure**

Run: yarn test test/telegram/interfaces/menu.handler.test.ts

Expected: FAIL because menu:sub:csv is absent.

- [ ] **Step 3: Implement delegation and documentation**

Inject CsvHandler using the existing forwardRef handler pattern. Add localized menu:sub:csv buttons to the top dashboard and Sensors submenu. Add the switch case that calls handleEmpty(ctx, 'menu'). Do not add CSV keyboard construction, parsing, staging, or repository access to MenuHandler.

Add catalogue rows for TIMEZONE_OPTIONS, SensorLogExportReaderPort, and CsvTempFilePort. Name ConfigModule, DrizzleSensorLogExportReader, InMemorySensorLogExportReader, and NodeCsvTempFileAdapter as the bindings/adapters.

- [ ] **Step 4: Verify menu integration**

Run: yarn test test/telegram/interfaces/menu.handler.test.ts test/telegram/interfaces/csv.handler.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/telegram/interfaces/menu.handler.ts test/telegram/interfaces/menu.handler.test.ts docs/ports-and-adapters.md
git commit -m "feat(telegram): expose CSV export in menu"
~~~

## Task 7: Run full regression verification

**Files:**
- Modify only files required to fix a failure in the contracts above.

**Consumes:** All preceding public interfaces.

**Produces:** Evidence that the CSV slice compiles and does not regress existing behavior.

- [ ] **Step 1: Run the complete suite**

Run: yarn test

Expected: PASS with no focused or skipped tests.

- [ ] **Step 2: Build production output**

Run: yarn build

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Check final scope**

Run: git diff --check && git status --short

Expected: no whitespace errors; only CSV feature files plus pre-existing unrelated changes.

- [ ] **Step 4: Perform the Raspberry Pi staging smoke test**

On a Raspberry Pi target, export a generated 8 MiB CSV fixture while a 100 ms interval records event-loop delay. Record maximum delay and total staging time in the implementation handoff. Do not increase MAX_CSV_BYTES if this materially delays sensor processing.

- [ ] **Step 5: Commit only a regression correction, if one was required**

If a regression command exposed and the engineer fixed a defect within this feature, stage exactly those correction files and commit with:

~~~bash
git commit -m "test: verify CSV export integration"
~~~

Do not create an empty verification-only commit.

## Plan Self-Review

- **Spec coverage:** Tasks 1–6 implement shared timezone injection; SQL-paged current/disabled/archived targets; active-first duplicate names; verified short callbacks; 5000-row, 256 KiB source-row, and 8 MiB output limits; chronological output; BOM/RFC 4180/formula protection/value mapping; private-file lifecycle; non-expiring consumed-picker locks; menu integration; locale copy; gateway/module wiring; and catalogue updates. Task 7 verifies the full slice.
- **Placeholder scan:** Every limit, port, path, callback grammar, error condition, and verification command is explicit.
- **Type consistency:** SensorLogExportReaderPort.withRows is synchronous throughout Tasks 3–4; CsvTempFilePort.stage consumes Iterable<string>; CsvHandler receives CsvTempFile only after snapshot staging is complete.

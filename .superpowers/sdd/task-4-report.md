# Task 4 — Format and stage bounded CSV documents

## Delivered

- Added the `CsvTempFilePort`, an 8 MiB `CsvDocumentTooLargeError`, and a Node adapter that writes `wx` files in a 0700 directory with 0600 file modes.
- Added exact UTF-8 byte accounting, short-write completion, idempotent disposal, independent read streams, and safe one-hour stale cleanup limited to regular `csv_` files.
- Added the streaming RFC 4180 formatter: UTF-8 BOM, CRLF rows, formula protection, timezone offsets, ppm extraction, and the bounded binary-state vocabulary.
- Added `StageCsvExportUseCase`, which stages formatter chunks synchronously in `ReadSensorLogHistoryUseCase`'s snapshot callback with a 256 KiB message bound.
- Wired the adapter port and staging use case into `TelegramModule`.

## TDD evidence

The three Task 4 test files were created first. Their initial focused run failed during test collection only because the formatter, staging use case, and temp-file port/adapter did not exist. After implementation, the focused suite passed.

## Verification

- `yarn test test/telegram/application/csv-export.formatter.test.ts test/telegram/application/stage-csv-export.use-case.test.ts test/telegram/infrastructure/node-csv-temp-file.adapter.test.ts` — 3 files, 23 tests passed.
- `yarn build` — passed.
- `yarn test` — passed (exit 0).
- `git diff --check` — passed.

## Documentation consulted

- Context7 `date-fns-tz`: `formatInTimeZone` accepts a `Date`, IANA timezone, and `XXX` numeric-offset format token.
- Context7 Node.js: exclusive `wx` creation, synchronous directory modes, streaming reads, and `lstat` file-type checks.

## Commit

`f301a19 feat(telegram): stage bounded CSV exports`

## Concerns

None.

## Collision safety fix

- Staged files now use a UUID-suffixed private on-disk path created with exclusive `wx` mode; `CsvTempFile.filename` remains the deterministic download filename.
- The failure cleanup path is assigned only after this invocation has successfully created a file, so an `EEXIST` from an attempted creation cannot unlink another export.
- Added `preserves independent readable exports with the same download filename`, which stages two same-name exports concurrently and verifies both original filename contracts and independent contents.

## Collision fix verification

- Red: `yarn test test/telegram/infrastructure/node-csv-temp-file.adapter.test.ts` — failed as expected with `EEXIST` for the second `same-name.csv` stage.
- Green: `yarn test test/telegram/infrastructure/node-csv-temp-file.adapter.test.ts` — 1 file, 6 tests passed.
- Focused Task 4 suite: `yarn test test/telegram/application/csv-export.formatter.test.ts test/telegram/application/stage-csv-export.use-case.test.ts test/telegram/infrastructure/node-csv-temp-file.adapter.test.ts` — 3 files, 24 tests passed.
- `yarn build` — passed (exit 0).
- `git diff --check` — passed.

# Public Signed OTA — Task 8 Report

## Outcome

Implemented the scoped secure archive and Yarn-cache inspectors. Tar archives are
streamed through gzip and `tar-stream`, extracted only into a private candidate,
and fail closed as `archive-policy` for unsafe structure, paths, modes, declared
inventory mismatches, resource bounds, truncation, or trailing data. Yarn cache
ZIPs are opened one at a time with yauzl lazy entries, strict names, and entry-size
validation; their contents are drained and bounded while exact ZIP path, byte
size, and SHA-256 records are returned.

No installer, updater wrapper, DI wiring, or speculative orchestration was added.

## Files

- `package.json`
- `yarn.lock`
- `src/system/infrastructure/archive-inspector.ts`
- `src/system/infrastructure/yarn-cache-inspector.ts`
- `test/fixtures/ota/archives/archive-fixtures.ts`
- `test/system/infrastructure/archive-inspector.test.ts`
- `test/system/infrastructure/yarn-cache-inspector.test.ts`

## Policy implemented

- Tar input is opened no-follow and streamed through `createGunzip()` into
  `tar-stream.extract()`; every entry stream is consumed before the next entry.
- Only directories and regular files are accepted. PAX metadata, link names,
  links, special/unknown/sparse types, invalid/control names, normalization
  changes, duplicate paths, and unsafe permission bits are rejected.
- Compiled ceilings remain 20,000 archive entries, 512 MiB expanded bytes,
  64 MiB per regular file, and 240 UTF-8 bytes per normalized path. Signed lower
  entry/expanded limits and exact signed entry/regular-byte inventory are also
  enforced.
- Candidate files use exclusive `O_NOFOLLOW` opens; directories are checked and
  opened `O_DIRECTORY | O_NOFOLLOW`. Directories normalize to `0755`, normal files
  to `0644`, and the fixed operational allowlist (`update.sh`, `rollback.sh`, and
  `system-update.sh`) to `0755`. Archive ownership is never restored.
- Yarn cache roots/files reject links and non-ZIP entries. Each ZIP uses
  `lazyEntries: true`, `validateEntrySizes: true`, and `strictFileNames: true`;
  encrypted entries, methods other than store/deflate, malformed/duplicate names,
  declared/actual size mismatches, and prepared count/byte excesses fail closed.
- ZIP files are hashed by streaming their exact bytes and are identity-checked by
  descriptor metadata before and after inspection.

## TDD evidence

RED:

```text
corepack yarn test test/system/infrastructure/archive-inspector.test.ts test/system/infrastructure/yarn-cache-inspector.test.ts
Test Files  2 failed (2)
Tests       no tests
Cause: both inspector modules were absent
```

Final GREEN:

```text
corepack yarn test test/system/infrastructure/archive-inspector.test.ts test/system/infrastructure/yarn-cache-inspector.test.ts
Test Files  2 passed (2)
Tests       29 passed (29)
```

The deterministic local fixture generator covers the brief's named tar and ZIP
attack matrices plus the directly specified invalid-UTF-8, trailing-tar, signed
inventory, configured-bound, mode-normalization, and no-follow checks. Hostile tar
fixtures use matching declared inventory so they cannot pass merely because of an
unrelated signed-count mismatch.

## Verification

```text
corepack yarn build
exit 0

corepack yarn eslint src/system/infrastructure/archive-inspector.ts src/system/infrastructure/yarn-cache-inspector.ts test/system/infrastructure/archive-inspector.test.ts test/system/infrastructure/yarn-cache-inspector.test.ts test/fixtures/ota/archives/archive-fixtures.ts
exit 0

git diff --check
exit 0
```

Current tar-stream and yauzl APIs were checked through Context7 before
implementation (`/mafintosh/tar-stream`, `/thejoshwolfe/yauzl`).

## Narrow directory-header review fix

A follow-up review found that normal TAR directory names ending in one slash,
such as `dist/`, reached the generic component validator with a terminal empty
component and were rejected. The fix removes exactly one terminal slash only
when tar-stream identifies the entry as a `directory`, then uses the resulting
path for all validation, duplicate detection, and extraction. File entries keep
the original strict rule, and a second trailing slash still fails normalization.

Review-fix RED:

```text
corepack yarn test test/system/infrastructure/archive-inspector.test.ts
Test Files  1 failed (1)
Tests       1 failed | 22 passed (23)
Cause: directory entry `dist/` rejected by canonicalArchivePath
```

Review-fix GREEN:

```text
corepack yarn test test/system/infrastructure/archive-inspector.test.ts
Test Files  1 passed (1)
Tests       25 passed (25)
```

The review fixtures also prove that a file named with a trailing slash remains
rejected and that directory entries `dist/` and `dist` collide as one canonical
duplicate identity.

## Caveats

- A repository-wide `corepack yarn test` sweep reached unrelated existing
  QuickTunnel RTSP tests that cannot bind their UNIX sockets in this sandbox
  (`listen EPERM`); the full sweep therefore did not complete. The Task 8 focused
  suites are green.
- Repository-wide non-mutating ESLint reports 20 existing errors in files outside
  Task 8. The complete Task 8 changed-file lint command above is clean.
- tar-stream consumes extension headers internally. The inspector rejects surfaced
  PAX metadata and every final type other than directory/file, including the
  deterministic sparse/unknown-type fixture; it does not introduce a second tar
  parser solely to expose tar-stream's internal extension records.
- The pre-existing untracked `scripts/__pycache__/` directory was not read,
  modified, staged, or removed.

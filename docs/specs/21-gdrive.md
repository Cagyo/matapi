# 21 — Google Drive Archive

## Dependencies
- 01-database.md (archive manifest, motion-event compatibility columns)
- 20-camera.md (completed Motion files and local cleanup)
- 00-overview.md (Node 22 and archive environment)

## Ownership and authentication

The `archive` bounded context owns Google Drive. An administrator uploads a
Google OAuth installed-client JSON document through Telegram; the bot deletes
the message document after reading it. Device authorization is polled in a
bounded background operation, and account confirmation activates a new
generation only after its permission identity and private folder tree are
verified. Client secrets, device codes, tokens, and resumable-session URLs are
never logged or shown by status commands.

Google's device response uses `verification_url`; the validated URL reaches the
authorization message byte-for-byte unchanged, and `user_code` retains its exact
case. Device-code failures use `error_code` with `error` as a compatibility
fallback, while token and revoke failures use `error`. Recognized discriminators
map to typed pending, denied, policy, client-rejected, reauthorization, and
rate-limit errors; HTTP 429 maps to rate limiting, and unknown provider content
maps to a sanitized temporary/provider-response failure. In particular,
device-code `rate_limit_exceeded` and token/device `invalid_client` retain their
dedicated localized outcomes.

OAuth response JSON is read through a bounded streaming parser: bodies are at
most 64 KiB, device codes 4 KiB, user codes 64 printable ASCII bytes, and display
or discovered endpoint URLs 2 KiB. Display URLs must be absolute HTTP(S) URLs
without embedded credentials. Discovery endpoints must equal the fixed Google
device-code, token, and revoke endpoints; uploaded documents cannot redirect
them.

OAuth credentials are encrypted with AES-256-GCM. The encryption key is the
immutable root-provisioned `/etc/home-worker/archive.key`; reinstall and OTA
must validate it and never replace it. A missing or corrupt key makes Drive
`reauth_required` without stopping Motion, Telegram, or local backups.

The credential repository permits one staged generation for the whole
installation. Staging contention returns a retryable busy result without
discarding the existing owner. The previously active generation remains active
until account and managed-folder confirmation succeeds and activation commits
atomically; cancellation, timeout, provider rejection, or failed confirmation
discards only the exact staged receipt/generation.

## Folder and object model

Each installation uses private `Home Worker Archive`, `Motion`, and `Backups`
folders. Motion videos live at the exact nested path
`Home Worker Archive/Motion/YYYY/MM/DD/filename`; the date is derived once from
the trusted local Motion relative path. Database backups remain direct children
of `Backups` and never receive date folders.

Every year, month, and day folder has an immutable generated Drive ID and
installation/generation/role/path app properties. Discovery is bounded,
paginated, exact-parent, exact-owner, private, and fail-closed on incomplete
search or conflicting candidates. The durable folder repository keeps
append-only reservations: one revision-fenced current row per generation/path,
with earlier or replaced IDs retained as audit history. Missing IDs are replaced
through CAS; detached/conflicting branches remain blocked and alert an
administrator instead of creating parallel folder trees.

Every object is created under an immutable attempt row with installation,
generation, kind, source fingerprint, digest, and source-time app properties.
Replacement creates a new attempt; earlier Drive IDs and metadata remain audit
history. Legacy `motion_events` upload columns remain readable for rollback but
never authorize local or remote deletion.

Motion admission stores the first validated day path immutably and uses an
independent admission revision. Retryable admission records an absolute retry
deadline; terminal invalid/local-source outcomes never re-enter selection.
Queue selection excludes blocked date prefixes and is stable by creation time
and artifact ID before applying its bound.

## Upload and recovery

- Uploads stream in bounded byte ranges; the worker does not buffer videos.
- Resumable-session state and authoritative offsets are durable.
- Saved-session 200/201/308/404 outcomes reconcile before another attempt.
- Ambiguous responses search only by immutable attempt identity; they never
  adopt an unrelated object.
- A stalled transfer does not block snapshots, Motion registration, status,
  local cleanup, backups, or later non-overlapping scheduler work.
- Shutdown aborts in-flight network work within the PM2 handoff window.

A generation-scoped provider gate persists reason-first cooldown and block
state before work yields. Transport and rate-limit failures use bounded retry
slots and one post-cooldown probe; quota, capacity, policy, and reauthorization
remain distinct. A block from an old generation cannot block staged OAuth or
account confirmation: confirmation runs under the shared mutation lock, commits
the new active generation, replaces provider state, and then wakes dispatch.

## Backup

SQLite's online backup API creates and quick-checks an immutable local snapshot
before archive registration. Backups use the same attempt/upload/verification
pipeline as video. Local snapshot retention is seven days; remote backup
retention deletes only an exact, immediately revalidated active-generation ID.

## Reconciliation and retention

Reconciliation verifies parents, size, digest, app properties, revision,
ownership, sharing, and delete capability. Moved, replaced, shared, missing, or
otherwise ambiguous objects become detached audit records.

Retention runs only with a synchronized plausible clock. It expires verified
backups older than seven days, and quota reclamation considers old video only
under the documented deficit policy. Every permanent deletion reloads the
active generation, artifact, attempt, and exact object under the remote
mutation lock immediately before `deleteExact`. Trash, detached objects,
ambiguous objects, and unrelated account items are never bulk-listed or
deleted. Local cleanup verifies the current active-generation attempt and
never requests a remote deletion.

## Scheduling and configuration

`ArchiveSchedulerService` owns one bounded dispatcher. Defaults live under
`archive` in `config/defaults.yml`; optional environment overrides are bounded:

| Variable | Bounds | Default |
|---|---:|---:|
| `ARCHIVE_SCHEDULER_INTERVAL_MS` | 30,000–3,600,000 | 120,000 |
| `ARCHIVE_UPLOAD_LEASE_MS` | 60,000–86,400,000 | 300,000 |
| `ARCHIVE_NEWER_VIDEO_BATCH` | 1–100 | 3 |

Archive paths use the existing `MOTION_LOCAL_DIR`, `BACKUP_LOCAL_PATH`,
`HOME_WORKER_ARCHIVE_KEY_PATH`, and `HOME_WORKER_INSTALLATION_ID_PATH` seams.
Invalid schedule overrides fall back to checked-in defaults.

The interval is a safety/maintenance cadence, not an upload throttle. One
monotonic wake epoch drives one continuous single-flight pump: registration,
generation activation, traversal completion, transfer settlement, and durable
deadline expiry wake it. After each transfer settles it yields once and admits
the next eligible backup/video immediately, while preserving backup priority
and bounded fresh-video/retry fairness. There is never more than one active
upload. Backup creation, Motion traversal, reconciliation, retention, local
cleanup, Telegram, and Motion recording remain independently responsive.

One `ArchiveRemoteMutationLockService` instance fences generation activation,
retirement, folder resolution, reconciliation mutation, and exact-ID retention.
The provider gate wraps active-generation folder, upload, reconciliation,
account/quota, and deletion paths; staged OAuth and reauthorization bypass old
active-generation admission state.

## Status and alerts

`/gdrive status` reports generation state, permission identity, quota, aggregate
archive/attempt and queued/retryable-video counts, oldest queue age, unhealthy
date-folder count, current drain state, traversal/registration progress, last
backup/upload/reconcile/cleanup times, reclamation accounting, and required
actions. It never reports a local path, filename, date branch, artifact ID,
Drive ID, provider body, token, or session URI. Durable,
cooldown-deduplicated alerts cover reauthorization, policy rejection, quota
review, unhealthy date-folder branches, provider capacity, prolonged provider
cooldown/backlog age, remote detachment/missing objects, retired generations,
prolonged upload/backup failure, corrupt credentials, clock health, and local
disk pressure.

The aggregate archive, attempt, and queue sections never enumerate artifact,
attempt, object, or date-folder IDs. Managed root, Motion, and Backups folder
hyperlinks are the approved exception: `/gdrive status` is restricted to the
private administrator interface, and those three navigation links are useful
for direct inspection. The exception does not permit local paths, filenames,
per-object links, provider payloads, tokens, or session data.

## Release evidence

Automated tests use in-memory repositories and fake Google gateways. Before a
release, an operator must complete and record
`test/archive/google-drive-date-folders-live-smoke.md` on the actual supported Raspberry Pi
hardware/OS/architecture combinations. CI evidence is not a substitute for
that on-device and disposable-account record.

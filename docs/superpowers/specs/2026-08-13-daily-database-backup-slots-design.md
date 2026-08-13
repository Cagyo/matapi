# Daily Database Backup Slots and Quiet Detachment Reporting

**Date:** 2026-08-13

## Problem

Database snapshots currently use millisecond-precision timestamped names and
are registered as immutable archive artifacts. Remote and local retention is
age-based at seven days. Although the scheduler normally creates only one
snapshot per configured local calendar day, retries and historical snapshots
can leave more visible files than the administrator wants.

Drive reconciliation also sends the administrator this Telegram message when
any field in a broad metadata comparison changes:

```text
⚠️ An archive object changed outside the worker and was detached safely.
```

The comparison currently includes provider metadata such as Drive `version`,
`headRevisionId`, creation time, MD5, and `webViewLink`. A difference in one of
those fields can therefore detach an object even when its SHA-256 content and
security ownership still match. The durable detach reason is only
`remote_metadata_changed`, so the notification does not reveal which invariant
failed.

## Goals

- Keep one managed database backup object per configured local calendar day.
- Keep the timestamp in the filename, but omit milliseconds.
- Overwrite the existing local file and exact Drive object when the same day's
  backup slot is refreshed.
- Retain the newest 10 daily backup slots locally and in the active managed
  Drive folder.
- Stop proactive Telegram delivery for remote-object detachment while keeping
  detached counts visible in `/gdrive status`.
- Detach only for meaningful content, placement, ownership, sharing, or managed
  identity changes; refresh harmless provider metadata drift.
- Preserve local backup creation when Drive is unavailable.

## Non-goals

- Changing Motion video naming, immutability, upload, or retention.
- Adding manual backup or restore commands.
- Removing Google Drive's internal revision history. Drive can retain revisions
  behind one visible object; the worker controls visible managed objects, not
  provider-internal revision storage.
- Automatically modifying, overwriting, or deleting detached, ambiguous,
  retired-generation, or otherwise unmanaged Drive objects.
- Changing the normal once-per-local-day schedule or the 24-hour boot catch-up.

## Terminology and Identity

A **backup day** is `yyyy-MM-dd` calculated from the snapshot source time in the
configured IANA `TIMEZONE`. It is stored as data and is not inferred from the
UTC filename.

A **daily backup slot** is identified by installation ID, artifact kind
`database_backup`, and backup day. The slot owns one stable local filename and,
while its Drive generation is active and manageable, one exact Drive file ID.

The first successful snapshot for a new slot chooses a filename from its UTC
source time with second precision:

```text
worker-2026-08-13T112530Z.db
```

Later refreshes of that backup day reuse the stored filename. They do not rename
the file to the retry time and do not create another visible object. The slot's
current source time, size, nanosecond modification time, SHA-256, and source
fingerprint are updated to describe the latest local bytes.

Internal manifest revisions and upload audit records are not additional backup
files. They may be retained where necessary for crash recovery and diagnostics.

## Architecture and Ownership

The existing bounded-context ownership remains in force:

- `database` owns SQLite online backup creation, `quick_check`, local staging,
  durable publication, filename selection, and local file retention;
- `archive` owns daily-slot registration, Drive create/update orchestration,
  remote verification, reconciliation, and remote retention;
- Telegram only renders archive application results and status.

Cross-context calls continue through application ports. The database adapter
does not import the archive repository, and archive application code does not
perform filesystem or Drizzle operations directly.

`DatabaseBackupDescriptor` gains an explicit backup-day value. The snapshot
port gains daily create-or-replace semantics while preserving its existing
stale-temporary cleanup and pinned retention responsibilities.

The archive context introduces a backup-slot application abstraction rather
than weakening Motion video's immutable artifact rules. Its repository stores:

- stable slot identity and filename;
- current local descriptor and source revision;
- desired versus last-verified remote source revision;
- active generation and exact remote file ID;
- upload lease/session state needed for resumable create or update;
- verified Drive metadata and sanitized reconciliation state; and
- a CAS revision for concurrent scheduler, upload, reconciliation, and cleanup
  decisions.

The Google Drive port adds a resumable update operation for an existing binary
file. New slots retain the existing reserved-ID create operation. Existing
Motion upload behavior remains unchanged.

Any schema change is made in `src/database/schema.ts` and generated through
`yarn db:generate`; migration SQL and migration metadata are never hand-edited.

## Local Snapshot Flow

1. The scheduler acquires the existing durable backup lease and calculates the
   backup day using the configured timezone.
2. The database adapter locates the slot's stored filename, or chooses a new
   second-precision UTC filename when the day has no slot.
3. SQLite's online backup API writes to a uniquely reserved temporary path in
   the managed backup staging directory.
4. The adapter runs `PRAGMA quick_check`, fsyncs the completed temporary file,
   and derives its full descriptor and SHA-256 without buffering the database.
5. Daily-slot registration durably records the desired source revision before
   the temporary snapshot can be treated as disposable.
6. The adapter atomically replaces the stable daily filename on the same
   filesystem and fsyncs the containing directory. An existing daily file is
   replaced only after the new snapshot passes validation.
7. The slot is marked locally current and `lastBackupSuccessMs` is advanced.
   Drive availability is not part of local backup success.
8. The archive dispatcher creates or updates the remote object asynchronously
   from the stable, pinned local source.

Only one refresh for a daily slot can be staged or uploaded at a time. A crash
between registration and local publication is recovered from the durable slot
state and reserved temporary file. If the staged file is missing or invalid,
recovery preserves the previously published local snapshot, clears only the
incomplete desired revision, and retries safely.

A Drive upload failure never rolls back or deletes the newer valid local
snapshot. The slot records that the remote revision is behind and retries from
the pinned local file. Normal scheduling still marks the day's local backup as
successful, so Drive outages do not create a new snapshot every scheduler tick.

## Drive Create and Same-Day Update Flow

For a new daily slot, the existing reserved-ID resumable-create flow uploads and
verifies one private object under `Backups`.

For an existing slot:

1. The archive update claims the slot's desired source revision and enters the
   existing remote-mutation activity boundary.
2. It reloads the active generation and exact remote file ID.
3. It performs an immediate exact-ID preflight. Parent, MIME type, current
   expected digest, ownership, sharing, deletion capability, and managed app
   properties must match the last verified slot revision.
4. A failed preflight stops the update and applies the normal missing or
   detached state. The worker does not blindly overwrite a remote object that
   is already different.
5. The worker initiates `files.update` for that exact ID, streaming the new
   SQLite bytes through a resumable session. The request updates the managed
   source metadata, including backup day, source fingerprint, digest, source
   time, and slot source revision.
6. Resumable session URI and confirmed-offset handling remain encrypted,
   durable, bounded, and abortable.
7. Completion reloads the exact object and verifies its new SHA-256, size,
   parent, ownership, sharing, deletion capability, and app properties.
8. A CAS commit advances the slot's verified remote revision and stores the new
   provider metadata. The same remote file ID remains current.

The Drive API documents `files.update` as updating an existing file's metadata,
content, or both. It does not document a file-resource compare-and-swap query
parameter for binary updates. The immediate preflight, worker mutation lock,
managed source revision, streamed source verification, and post-update exact-ID
verification are therefore the required guards. A provider or user mutation
racing inside the remote update request is a residual risk and must be stated
in release notes; the worker never suppresses a mismatch observed before or
after its own update.

## Retention

Retention is count-based and ordered by backup day, with source time and stable
slot ID as deterministic tie-breakers. Age and Drive `createdTime` no longer
decide database-backup retention.

After a new slot is locally current, local cleanup keeps the newest 10 backup
days. A path needed by an unverified or in-flight slot remains pinned. Safety
can therefore temporarily leave more than 10 local files, but convergence to 10
is retried and reported rather than deleting the only recoverable source.

After the newest slot is remotely verified, remote cleanup keeps the newest 10
manageable active-generation backup days. Each deletion reloads the active
generation, slot, exact object, and verified metadata under the remote mutation
lock immediately before `deleteExact`. Failed, missing, detached, ambiguous,
trashed, or retired-generation objects are never counted as authorization for
deletion and are never bulk-deleted.

The limit applies independently to the worker's local managed backup set and
active Drive managed backup set. Cleanup may briefly expose an eleventh object
while its replacement is being verified. Persistent excess is visible through
status and retried; data safety takes precedence over a destructive hard cap.

## Reconciliation and Detachment

Reconciliation separates required invariants from refreshable provider
metadata.

The following remain detachment reasons:

- `content_changed`: size or SHA-256 differs from the slot's expected revision;
- `moved`: the exact object is outside the managed Backups folder;
- `type_changed`: MIME type differs;
- `ownership_changed`: ownership or owner permission identity differs;
- `sharing_changed`: the object is shared or has unexpected permissions;
- `delete_capability_changed`: the active installation can no longer delete it;
- `managed_properties_changed`: installation, generation, kind, backup day,
  source revision, fingerprint, digest, or source time properties differ; and
- `manifest_incomplete`: a verified attempt lacks required stored identity.

Drive `version`, `headRevisionId`, creation time, MD5, and `webViewLink` do not
detach an object by themselves when all required invariants still match. A
manual rename remains accepted. In both cases reconciliation refreshes the
stored provider metadata with CAS fencing and keeps the slot verified.

Missing or trashed objects continue through the existing missing-object flow.
If the trusted local slot source is unchanged, the worker may create a
replacement exact ID with the same stable filename because the previous object
is no longer visible. Detached objects are not overwritten or replaced
automatically.

Detach reasons are sanitized category codes. Provider messages, Drive links,
Drive IDs, account identifiers, local paths, and credentials do not enter
alerts or logs.

## Bot and Status Behavior

Reconciliation no longer calls the archive alert port for
`remote-object-detached`. No new durable system event or direct administrator
message is created for this condition. The existing locale key can remain for
rendering historical queued events during rollout, but production code does not
enqueue new ones.

`/gdrive status` continues to show missing and detached counts and the existing
manual-cleanup action when either count is nonzero. Other archive alerts,
including reauthorization, missing objects without a trusted local source,
quota review, prolonged failures, corrupt credentials, clock health, and local
disk pressure, remain unchanged.

## Existing Backup Adoption

Rollout derives each existing database artifact's backup day from its durable
`sourceTimeMs` in the configured timezone; it does not parse the filename to
decide the day.

For multiple manageable active-generation backups on one day, the newest
verified source time becomes the canonical slot. Its filename is normalized to
second precision by removing milliseconds. Older same-day objects are deleted
only after the canonical slot is exactly revalidated and only through the
normal exact-ID retention path. Unverified local paths remain pinned until they
become safe to prune.

Detached, ambiguous, retired-generation, and unmanaged duplicates are preserved
for manual review. They remain visible in status and can make the physical Drive
folder exceed the managed 10-slot target; the worker does not trade deletion
safety for cosmetic convergence.

After same-day canonicalization, ordinary count retention removes manageable
slots older than the newest 10 backup days. Adoption is restart-safe and
idempotent.

## Error Handling and Recovery

- Snapshot, `quick_check`, fsync, or atomic-publication failure leaves the
  previous daily local file intact and does not advance backup success.
- Durable registration failure cleans only an unreferenced temporary file.
- A crash after desired-source registration is recovered from the recorded
  source revision and exact staging path.
- A local source change during hashing or upload makes the attempt retryable;
  it never verifies mixed bytes.
- A Drive update preflight mismatch detaches or marks missing before mutation.
- Ambiguous upload completion reloads the exact ID and adopts it only when the
  desired slot revision matches completely.
- A remote update failure preserves both the latest local snapshot and the last
  verified remote revision, then retries with bounded backoff.
- Retention failure does not fail snapshot creation or remove unverified data.
- Clock or timezone configuration failure fails closed for day assignment and
  count retention; it does not guess a day or delete files.

## Testing

Test-driven implementation will cover these behaviors at the existing three
test tiers.

Domain and application tests:

- backup-day calculation across UTC offsets, local midnight, and DST changes;
- second-precision filename generation with no milliseconds;
- stable filename reuse for multiple refreshes of one day;
- distinct slots for adjacent local days even when their UTC date is equal;
- once-per-day and 24-hour catch-up behavior;
- slot lease, CAS conflict, restart, and incomplete-staging recovery;
- local success while Drive is unavailable;
- exact-ID create for a new day and update for an existing day;
- preflight refusal when remote content or security identity changed;
- resumable update retry and ambiguous-completion recovery;
- provider-only metadata refresh without detachment;
- categorized detachment for every required invariant;
- no `remote-object-detached` alert-port call or durable event;
- detached counts and manual-cleanup action remain in status; and
- newest-10 selection, tie-breaking, pinning, and eventual convergence.

Infrastructure tests:

- SQLite backup, `quick_check`, file fsync, atomic replacement, and directory
  fsync ordering against a real temporary SQLite database;
- an invalid replacement never clobbers the current daily file;
- Drizzle migration, unique daily-slot identity, CAS, leases, and resumable
  update persistence;
- Google adapter request shape for resumable `files.update` by exact ID;
- streaming behavior without whole-database buffering;
- legacy millisecond-name adoption and same-day canonicalization; and
- exact revalidation before each count-retention deletion.

Verification runs focused database snapshot, archive backup, upload,
reconciliation, retention, status, alert, and migration tests, followed by the
full test suite, build/type checks, and lint. The supported Raspberry Pi release
procedure must verify one create, one controlled same-day overwrite, restart
recovery, and 11-to-10 retention against a disposable Drive account.

## Success Criteria

- Normal scheduling creates one backup slot per configured local calendar day.
- A visible backup filename includes date and time to seconds and contains no
  milliseconds.
- Refreshing a day atomically replaces its local file and updates the same exact
  Drive object instead of creating another visible file.
- The newest 10 manageable daily backups remain locally and in active Drive
  after safe cleanup converges.
- Drive failure never prevents or rolls back a valid local daily snapshot.
- Provider-only metadata drift no longer creates a false detached state.
- Meaningful content or security drift remains detached and visible in
  `/gdrive status`.
- No new bot message or durable event says that an archive object changed and
  was detached safely.
- Motion video behavior and unrelated archive alerts are unchanged.

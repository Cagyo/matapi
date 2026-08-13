# Drive Motion Date Folders and Continuous Sync

> **Date:** 2026-08-13
> **Status:** approved design
> **Scope:** mirror the validated Motion `YYYY/MM/DD` hierarchy in Google
> Drive and continuously drain every surviving offline video backlog

## 1. Goal

Motion videos must be archived under the same date hierarchy used below the
local Motion video root:

```text
Home Worker/
├── Motion/
│   └── YYYY/
│       └── MM/
│           └── DD/
│               └── filename.avi|mkv|mp4
└── Backups/
    └── existing backup layout
```

The active `Home Worker`, `Motion`, and `Backups` managed folders remain
unchanged. Only motion videos gain the nested date hierarchy. Database backups
keep their current destination and priority.

When the worker has been offline, every valid local video that still exists
must eventually register and upload after Drive becomes available. The upload
queue must drain continuously rather than starting at most one new transfer per
two-minute scheduler tick. The drain remains bounded to one active transfer so
it respects Raspberry Pi resources and avoids unnecessary Drive API pressure.

## 2. Confirmed current behavior

The completed-file boundary already records a normalized path such as
`2026/08/13/120000-12345.avi`. `ArchiveArtifact.relativePath` persists that
value. The current upload use case discards its directory components, takes only
the basename, and assigns every motion upload directly to the managed `Motion`
folder ID.

Offline recovery exists in two stages:

1. Camera boot and periodic recovery find stable, unarchived Motion files and
   register idempotent archive artifacts.
2. The archive scheduler selects unattempted or retryable artifacts for the
   exact-ID resumable upload pipeline.

The recovery path therefore does not require a second sync subsystem. It needs
date-aware container resolution, continuous bounded admission, and regression
coverage proving that a backlog converges.

## 3. Non-goals

- Do not move or re-parent existing flat Drive videos.
- Do not add a remote migration command or automatic migration job.
- Do not rename, move, unshare, restore, or permanently delete user-modified
  Drive folders.
- Do not change the `Home Worker`, `Motion`, or `Backups` managed folder IDs.
- Do not parallelize media uploads.
- Do not change database-backup layout or retention policy.
- Do not weaken exact-ID ownership, sharing, checksum, revision, or deletion
  checks.
- Do not buffer a complete video in memory.

## 4. Architecture and ownership

The `archive` bounded context owns remote folder identity and continuous upload
admission. Camera owns local Motion discovery and never imports Google-specific
types.

### 4.1 Motion archive path

A pure archive-domain value object validates `ArchiveArtifact.relativePath` at
the remote boundary and exposes:

- `year`;
- zero-padded `month`;
- zero-padded `day`;
- `fileName`;
- normalized folder paths `YYYY`, `YYYY/MM`, and `YYYY/MM/DD`; and
- the content type derived from the validated extension.

The accepted form is exactly the existing Motion form:

```text
YYYY/MM/DD/HHMMSS-<safe event component>.avi|mkv|mp4
```

The parser rejects traversal, absolute paths, backslashes, extra or missing
segments, invalid Gregorian dates, years before the Unix epoch, non-padded
month/day values, unsupported extensions, and unsafe filenames. Leap days are
validated without using the process timezone.

The local relative path is authoritative. Upload time, retry time, Drive server
time, and the current wall clock never select the destination. This keeps the
folder stable across downtime, timezone changes, and daylight-saving changes.

Content types are:

| Extension | Drive content type |
|---|---|
| `.avi` | `video/x-msvideo` |
| `.mkv` | `video/x-matroska` |
| `.mp4` | `video/mp4` |

This corrects the current behavior that labels every accepted Motion format as
`video/mp4` even though the installed `movie_codec mpeg4` produces AVI files.

### 4.2 Folder resolution use case

`ResolveMotionArchiveContainerUseCase` accepts an active Drive connection and a
validated motion artifact. It resolves or creates `year -> month -> day` below
the exact managed `Motion` folder ID and returns the verified day-folder ID.

It depends on two provider-neutral ports:

- a Drive-folder port for generated IDs, exact metadata reads, bounded candidate
  listing, and folder creation; and
- a folder-reservation repository for durable exact-ID state.

The Google adapter implements Drive operations. Drizzle and in-memory adapters
implement reservation persistence. Application code does not import the Google
SDK or Drizzle.

### 4.3 Upload and reconciliation integration

`UploadDriveObjectAttemptUseCase` resolves and verifies the complete date folder
chain before it generates the video file ID or creates the immutable attempt.
The attempt persists the verified day-folder ID as its exact container.

Before resuming an existing nested attempt, the use case revalidates the folder
chain and requires the leaf ID to equal the attempt container ID. The file
upload then follows the existing exact-ID, bounded-streaming, durable-session,
and post-upload verification pipeline.

`ReconcileDriveUseCase` uses the same resolver when:

- replacing a missing or trashed video whose trusted local source survives; or
- finding a restoration candidate under its expected date folder.

Restoration groups candidates by resolved day-folder ID and performs bounded
leaf-folder listings. It no longer assumes all managed motion objects are direct
children of `Motion`. Permanent deletion remains authorized only by the exact
immutable object attempt after immediate revalidation.

## 5. Durable folder identity

Date folders use append-only reservations, matching the archive object's
existing attempt model. A reservation records:

- installation and connection generation;
- normalized folder path;
- level: year, month, or day;
- visible segment name;
- pre-generated Drive folder ID;
- exact parent folder ID;
- lifecycle state: `reserved`, `verified`, `missing`, `detached`, or `conflict`;
- compare-and-swap revision;
- sanitized error code; and
- creation, update, and verification timestamps.

Only one current reservation exists for a generation and normalized path.
Folder IDs are globally unique in local durable state. Superseded, missing,
detached, and conflicting reservations remain immutable audit history.

The database schema is changed through `src/database/schema.ts`, followed by
`yarn db:generate`. Generated migrations are never hand-edited.

### 5.1 Folder app properties

Every date folder uses compact, versioned private app properties containing:

- schema version;
- installation ID;
- connection generation;
- folder role: motion year, month, or day; and
- normalized relative folder path.

The largest relative folder path is only ten ASCII bytes, so it fits safely
within Drive's private-property limits. Names alone never establish identity.

### 5.2 Resolution algorithm

For each level, beginning with the managed `Motion` folder as parent:

1. Load the current reservation, if any.
2. Fetch its exact Drive ID and verify folder MIME type, expected parent, visible
   segment, app properties, My Drive ownership, private sharing, owner
   permission identity, and non-trashed state.
3. If no usable current reservation exists, paginate a parent-constrained
   search for folders with the exact private properties.
4. Restart a rejected page token once from the first page. Reject
   `incompleteSearch` and more than one valid candidate.
5. Reuse exactly one unambiguous valid candidate when repository state permits
   adoption.
6. Otherwise generate a Drive ID and persist its reservation before calling
   folder creation.
7. If creation has an ambiguous result, fetch that exact generated ID. Never
   guess from a name-only search.
8. Mark the reservation verified only after exact metadata validation.

One installation-wide remote mutation lock prevents competing folder creation
and activation/retirement changes. The existing one-transfer semaphore remains
the media concurrency boundary.

### 5.3 User-modified folders

A renamed, moved, shared, ambiguously duplicated, or metadata-modified date
folder becomes detached. Uploads for that date branch pause and raise a durable,
cooldown-deduplicated alert. Other healthy date branches may continue.

A missing or trashed folder may receive a newly reserved replacement chain.
Historical folder IDs remain recorded. Objects from the old chain are handled
individually by exact-ID reconciliation; no bulk adoption or deletion occurs.

## 6. Continuous local discovery

Camera recovery performs bounded filesystem work but continues until one whole
scan traversal completes:

1. Process a bounded batch of completed database events lacking archive
   references.
2. Advance the no-follow recursive filesystem cursor through a bounded batch.
3. Hash one stable file at a time with the existing 64 KiB read buffer.
4. Register artifacts and attach event rows idempotently.
5. Yield to the event loop.
6. If the traversal reports more work, dispatch the next batch immediately.
7. When one complete traversal finishes, sleep until a Motion event, boot
   recovery, or the periodic safety trigger wakes it again.

The completed-video port returns explicit traversal progress rather than
inferring completion from the number of valid descriptors. A directory full of
invalid, unstable, or already-known entries must still advance the cursor.

Only one recovery traversal runs at a time. A process restart safely begins
again from the root. Files added before a cursor position or while a directory
snapshot is being traversed may wait for the next safety traversal, but cannot
be lost permanently. Registration continues while Drive is offline.

## 7. Continuous Drive drain

`ArchiveSchedulerService` owns a single-flight drain pump. It wakes on:

- archive runtime start;
- Drive activation or recovery;
- new artifact registration;
- transfer completion or failure;
- the earliest durable retry or provider-cooldown deadline; and
- the existing periodic safety tick.

At each admission boundary it:

1. refuses work during shutdown or a provider-wide block;
2. gives due database backups first priority;
3. applies the existing bounded fairness rule between fresh videos and video
   retries;
4. claims or creates one exact attempt outside long database transactions;
5. starts one asynchronous transfer;
6. keeps reconciliation, backup creation, local cleanup, status, Motion, and
   Telegram independent of that transfer; and
7. after settlement, yields once and immediately checks for the next eligible
   item.

An empty queue arms only the next known deadline and the safety tick. The pump
does not poll in a tight loop. The existing two-minute interval becomes a
recovery signal, not the throughput limiter.

The scheduler stores provider failure streak, cooldown deadline, and block
reason durably. A successful provider operation clears the transient streak.
In-process waiting is cancellable; epoch deadlines allow restart recovery and
are bounded against implausible clock changes.

## 8. Drive limitations and retry policy

One media upload remains active installation-wide. Resumable chunks remain
multiples of 256 KiB except the final chunk. The worker treats Drive's confirmed
offset as authoritative and does not assume a sent chunk was committed.

Resumable status outcomes retain their current meaning:

- `200` or `201`: complete, then fetch and verify exact metadata;
- `308`: continue from the byte after Drive's returned range;
- `404`: session expired or unavailable, reconcile the reserved file ID and
  start a fresh session when the ID remains free.

The worker retains its conservative six-day local session expiry because Drive
documents a one-week session lifetime.

Retry scope is explicit:

| Failure | Scope and response |
|---|---|
| Offline transport, 403 rate-limit reason, 429, retryable 5xx | Preserve attempt/session when safe; pause the whole Drive pump with truncated exponential backoff and fresh jitter. |
| Ambiguous chunk response | Query the resumable session before sending more bytes. |
| Invalid or expired session | Reconcile the reserved exact ID, then create a new session for the same attempt when safe. |
| Storage quota exhausted | Run exact-ID retention once; if the deficit remains, block uploads and alert. |
| Daily/account creation or provider capacity limit | Persist a provider block or long cooldown and alert; do not cycle through artifacts. |
| Revoked authorization, account mismatch, policy rejection | Suspend remote work until administrator action or reauthorization. |
| Local source changed or missing | Stop only that artifact; never upload different bytes under its identity. |

Inline retries are bounded. Drive's documented truncated exponential policy is
used with approximately `1, 2, 4, 8, 16, 32, 64` second steps plus independently
recomputed jitter. After the inline budget, the attempt and provider cooldown
are persisted and the call returns. Background recovery remains eventual but
never becomes an unbounded in-call retry loop.

Quota numbers are not hard-coded into admission because Drive quotas can differ
by project cohort and account. The worker reacts to typed provider outcomes.

## 9. Error isolation and local safety

Failures are isolated at three levels:

- **Artifact-local:** invalid path, unsupported media, changed bytes, missing
  source, checksum mismatch, or immutable object conflict affects one artifact.
- **Folder-branch:** unhealthy folder identity pauses one date branch.
- **Provider-wide:** transport, rate, quota, authorization, account, or policy
  failure pauses all Drive mutation.

Drive failures never stop Motion recording, Telegram, registration, or local
database backups. Unverified artifact paths remain protected from automatic
local cleanup. If an extended outage causes disk pressure, the worker alerts
rather than silently deleting the only unsynced copy.

Logs and user-facing errors remain sanitized. They never include local paths,
Drive IDs, installation IDs, chat IDs, tokens, client secrets, provider response
bodies, resumable-session URIs, or bot-token-bearing URLs.

## 10. Existing flat Drive videos

There is no migration mechanism. Existing verified flat objects remain valid
under their immutable stored attempt parent and are not treated as detached
merely because new uploads use date folders.

After the new behavior is deployed and verified, the administrator may remove
old flat video objects from inside `Home Worker/Motion`. The administrator must
keep `Home Worker`, `Motion`, `Backups`, all date folders, and every required
local source file.

Deletion from the Drive UI normally makes the exact object trashed; permanent
deletion makes it missing. Reconciliation handles both as missing. If the local
file is still present and unchanged, it reserves a replacement attempt under
the resolved day folder and the continuous pump uploads it.

A remote-only video whose local source has already been pruned cannot be
re-uploaded. Such a flat object must be left in Drive or restored locally before
removal. Status and the operational runbook must state this warning explicitly;
the worker never claims that deleting every flat object is safe.

## 11. Status and alerts

`/gdrive status` adds aggregate-only fields:

- queued and retryable video counts;
- oldest queued-video age;
- drain state: active, idle, cooling down, quota-blocked, policy-blocked, or
  reauthorization-required;
- unhealthy date-folder count;
- last successful full Motion traversal;
- last successful artifact registration; and
- last successful Drive upload.

Durable deduplicated alerts cover unhealthy folder branches, prolonged provider
cooldown, storage/capacity block, reauthorization, prolonged backlog age, and
local disk pressure. Status and alerts contain no raw folder or object IDs.

## 12. Tests

### 12.1 Domain

- valid AVI, MKV, and MP4 paths;
- MIME mapping;
- leap years and invalid calendar dates;
- zero-padding, traversal, backslashes, absolute paths, unsafe filenames,
  unsupported extensions, and extra segments; and
- stable folder components independent of process timezone.

### 12.2 Application

- partial existing folder chains and exact-ID reuse;
- reservation persistence before remote create;
- restart after ambiguous create;
- duplicate candidates, rejected page tokens, and incomplete search;
- renamed, moved, shared, trashed, missing, and conflicting folders;
- concurrent resolution of the same path and connection-generation changes;
- upload attempts using the verified day-folder ID;
- resumed attempts revalidating the complete folder chain;
- backups retaining their existing destination;
- flat-object deletion producing a nested replacement attempt only when the
  trusted source survives;
- continuous next-item admission with exactly one active transfer;
- empty-queue sleep and wake-up on new work;
- backup priority and retry fairness during a large video backlog;
- one provider cooldown preventing a backlog-wide failure storm;
- quota, authorization, policy, cancellation, and restart behavior; and
- maintenance work continuing beside a stalled transfer.

### 12.3 Camera recovery

- more than 64 videos across multiple date folders;
- invalid and unstable files mixed with valid files;
- explicit cursor progress when a batch yields no valid descriptors;
- cooperative continuation to traversal completion;
- event and periodic wake-up coalescing;
- cancellation; and
- idempotent restart from the root.

### 12.4 Infrastructure and composition

- Drizzle reservation constraints, CAS behavior, restoration, and generated
  migration coverage;
- Google folder queries, generated-ID creation, exact metadata validation,
  pagination, and error mapping;
- resumable upload outcome and MIME metadata coverage;
- Nest wiring for every new port, repository, resolver, and wake-up signal; and
- no cross-context infrastructure imports.

### 12.5 On-device disposable-account smoke test

1. Record several videos while networking is unavailable.
2. Restore connectivity.
3. Confirm registration completes and the queue drains continuously without a
   two-minute pause between files.
4. Confirm the exact `Home Worker/Motion/YYYY/MM/DD/filename` hierarchy.
5. Restart during a resumable upload and confirm continuation or safe session
   replacement.
6. After verifying the matching local source exists, remove one old flat Drive
   video and confirm nested replacement.
7. Confirm database backups, Motion, Telegram, status, and local cleanup remain
   responsive throughout the drain.

## 13. Acceptance criteria

- Every newly uploaded valid motion video uses its exact local `YYYY/MM/DD`
  hierarchy below the existing managed `Motion` folder.
- Every surviving valid video recorded during an outage eventually registers
  and uploads after recovery.
- The uploader admits the next eligible artifact immediately after settlement,
  subject to backup fairness and Drive cooldowns.
- At most one media upload is active.
- Folder and object IDs are durable before ambiguous remote mutations.
- Restarts preserve folder resolution, retry deadlines, attempts, and resumable
  progress.
- Rate limits and retryable server failures produce bounded exponential backoff,
  not a request storm.
- Existing flat objects are neither moved nor automatically deleted.
- A manually removed flat object is recreated only from a surviving unchanged
  local source.
- Database backups and non-Drive runtime behavior remain available during
  backlog drain and Drive failure.

## 14. Primary references checked

- [Google Drive: upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive: usage limits](https://developers.google.com/workspace/drive/api/guides/limits)
- [Google Drive: resolve errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)
- [Google Drive: create and populate folders](https://developers.google.com/workspace/drive/api/guides/folder)
- [Google Drive: search for files and folders](https://developers.google.com/workspace/drive/api/guides/search-files)
- [Google Drive: custom file properties](https://developers.google.com/workspace/drive/api/guides/properties)
- [Google Drive: generate IDs](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds)
- [Motion movie configuration](https://motion-project.github.io/motion_config.html)

These references were checked on 2026-08-13. Runtime error classification,
rather than fixed numeric quota assumptions, remains authoritative.

# Drive Motion Date Folders and Continuous Sync

> **Date:** 2026-08-13
> **Status:** approved design; pressure-test amendments folded 2026-08-27
> **Scope:** mirror the validated Motion `YYYY/MM/DD` hierarchy in Google
> Drive and continuously drain every surviving offline video backlog

## 1. Goal

Motion videos must be archived under the same date hierarchy used below the
local Motion video root:

```text
Home Worker Archive/
├── Motion/
│   └── YYYY/
│       └── MM/
│           └── DD/
│               └── filename.avi|mkv|mp4
└── Backups/
    └── existing backup layout
```

The active `Home Worker Archive`, `Motion`, and `Backups` managed folders remain
unchanged. `Home Worker Archive` is the current visible root-folder name; exact
IDs and private app properties, not names, remain authoritative. Only motion
videos gain the nested date hierarchy. Database backups keep their current
destination and priority.

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
- Do not automatically mutate a user-modified folder to heal a blocked branch.
  Exact revalidation after the administrator restores the expected metadata, and
  a bounded administrator-requested retry, are allowed because neither changes
  remote state.
- Do not change the `Home Worker Archive`, `Motion`, or `Backups` managed folder
  IDs or rename those managed folders.
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
month/day values, invalid `HHMMSS` clock values, unsupported extensions, and
unsafe filenames. Calendar and clock validation never use the process timezone.

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

Complete-chain validation is a pre-transfer and post-transfer invariant. After
the exact object metadata and transferred bytes pass verification, but before
the attempt and artifact become `verified`, the use case resolves the complete
year/month/day chain again and requires the resulting leaf to equal the
attempt's immutable container. This closes the user-mutation window during a
long upload. If the chain is now missing, detached, or conflicting, the exact
object remains attached to its historical attempt, the local source remains
protected, and normal exact-ID reconciliation decides whether a replacement is
eligible. The upload path never marks the artifact verified merely because the
object still names the old leaf folder as its immediate parent.

If a missing or trashed folder has been replaced and the resolved leaf no longer
equals a pending, uploading, or retryable attempt's immutable container, the use
case does not reuse that attempt under the new folder. It first queries any
durable resumable session when the provider outcome was ambiguous, reloads the
old exact object ID, and classifies that ID without adopting it into the new
branch. When no exact verified object survives, the use case pre-generates a
replacement file ID outside any database transaction. One CAS-fenced repository
transaction then verifies the old revision and container and:

1. terminalizes the old attempt as `missing`, `detached`, or `abandoned`;
2. clears its lease and encrypted session;
3. persists that replacement file ID with the new verified day-folder ID; and
4. leaves the replacement immediately eligible for the pump.

If the old exact object exists, it remains bound to its historical attempt and
is reconciled by exact ID. The worker never changes an attempt's stored
container in place.

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
- lifecycle state: `reserved`, `verified`, `missing`, `detached`, `conflict`, or
  `superseded`;
- nullable current slot;
- compare-and-swap revision;
- revalidation failure streak;
- sanitized error code; and
- creation, update, verification, and next bounded revalidation timestamps.

The reservation table has a partial unique index on
`(generation, normalized path)` where `currentSlot = 1`, plus a global unique
constraint on Drive folder ID. A row owns the current slot while it is the head
for that path. Its state and revision may change through CAS while current; after
its current slot is cleared, the row is immutable audit history.

Replacement is one database transaction. It verifies the current row and
revision, clears that row's current slot, preserves its terminal reason, and
inserts the newly pre-generated reservation into the current slot. A verified
descendant whose expected parent was replaced by worker-controlled missing-folder
repair becomes `superseded`; a folder observed to have been moved or modified by
the user becomes `detached` instead. `detached` and `conflict` heads remain
current and block normal admission and creation. Only the separate bounded
revalidation transition described below may heal or replace them. Missing,
detached, conflicting, and superseded rows remain immutable history once they
leave the current slot. A current detached row may return to `verified` only
through an exact-ID read proving that the administrator restored every expected
metadata invariant. A conflict head never changes its reserved folder ID; when
one valid candidate remains, one CAS transaction clears the conflict head and
adopts the surviving exact ID in a new current reservation.

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
4. Restart a rejected page token once from the first page. A second rejected
   token, `incompleteSearch`, or the configured page bound is retryable
   discovery uncertainty and does not create a durable conflict head.
5. Reuse exactly one unambiguous valid candidate when repository state permits
   adoption.
6. If the parent-constrained search finds no valid candidate and repository
   state is absent, run one bounded identity-only search using the exact private
   properties without assuming the current parent or visible name. This is the
   database-rollback recovery path. A renamed, moved, shared, or otherwise
   modified exact-identity candidate becomes detached; several identity
   candidates become conflict; a trashed identity is recorded as missing audit
   history and is not a usable live identity. The resolver must not create a
   parallel branch merely because a user-modified identity was filtered out of
   the first search.
7. Only after both searches prove that no live identity requires detachment or
   conflict handling—either no identity exists or every discovered identity was
   recorded as trashed history—generate a Drive ID and persist its reservation
   before calling folder creation.
8. If creation has an ambiguous result, fetch that exact generated ID. Never
   guess from a name-only search.
9. Mark the reservation verified only after exact metadata validation.

Adoption and creation both CAS the same current slot. Losing that CAS causes the
resolver to reload the winning head rather than create another folder. A
`detached` or `conflict` head returns a typed branch-blocked outcome during
normal upload admission without a provider search. When an ancestor is
replaced, verified descendants tied to the old parent are superseded in the same
database transaction and replaced level by level under the new parent.

Blocked heads have a separate low-frequency revalidation path. Each blocked
head records a durable next-check deadline using approximately `15m, 30m, 1h,
2h, 4h, 6h` slots with fresh jitter and a six-hour cap. The branch probe
performs at most one exact read for a detached head or one bounded candidate
traversal for a conflict head. An exact administrator
restoration may return a detached head to `verified`; removal of duplicate
candidates may replace a conflict marker with one adopted reservation. Failed
probes advance the deadline and remain fail-closed. Drive activation and an
administrator retry action may request the same single bounded probe early;
they never clear state optimistically.

One installation-wide remote mutation lock prevents competing folder creation
and activation/retirement changes. The existing one-transfer semaphore remains
the media concurrency boundary.

### 5.3 User-modified folders

A renamed, moved, shared, or metadata-modified date folder becomes detached.
Several valid identities for one path become conflict. Uploads for that date
branch pause and raise a durable, cooldown-deduplicated alert. Other healthy
date branches may continue.

`incompleteSearch`, exhausted pagination, transport failure, and a rejected page
token are not evidence that the remote identity conflicts. They remain
retryable provider/discovery outcomes, enter the generation-scoped folder
operation cooldown, and never poison a branch permanently or cycle through
every artifact for the same path.

Branch health is part of archive admission, not merely an upload exception.
Before selecting unattempted motion artifacts, the repository excludes paths
whose year, month, or day head is `detached` or `conflict`. A bounded candidate
scan must advance past a blocked path and may not repeatedly return the same
oldest artifact. Invalid paths and unsupported media receive a durable
artifact-local terminal admission error. Failures that happen before an object
attempt exists therefore cannot cause head-of-line blocking or a tight retry
loop.

A missing or trashed folder may receive a newly reserved replacement chain.
Historical folder IDs remain recorded. Objects from the old chain are handled
individually by exact-ID reconciliation; no bulk adoption or deletion occurs.

### 5.4 Artifact admission state

Archive artifacts persist provider-neutral admission state so failures before an
object attempt exists are schedulable:

- admission state: `ready`, `retryable`, or `terminal`;
- the validated normalized motion day path, nullable until first admission;
- next admission deadline;
- sanitized error code; and
- CAS revision.

Registration creates `ready` admission state. The first successful path parse
immutably records the normalized day path. Temporary pre-attempt failures become
`retryable`; invalid paths, unsupported media, changed local identity, and other
artifact-local permanent failures become `terminal`. Queue selection excludes
terminal artifacts, respects admission deadlines, and joins a known day path to
current folder heads so blocked branches are skipped without provider calls.

## 6. Continuous local discovery

Camera recovery performs bounded filesystem work but continues until one whole
scan traversal completes. Bounds apply to directory enumeration, hashing bytes,
wall time, memory, and accepted descriptors, not only to the number of returned
videos:

1. Process a bounded batch of completed database events lacking archive
   references.
2. Advance an adapter-owned, process-local no-follow directory iterator through
   at most the configured entry bound. Directory enumeration streams entries;
   it never loads or sorts an unbounded directory merely to return one batch.
3. Return cheap path and stable-stat candidates before hashing. Camera checks
   its event state and a provider-neutral Archive registration-lookup port, then
   skips already-known immutable files. Camera never imports an Archive
   repository or persistence type.
4. Resolve and hash only unknown candidates, one at a time, using the existing
   64 KiB read buffer and a bounded total hash-byte budget per batch.
5. Register artifacts and attach event rows idempotently.
6. Yield to the event loop after the entry, byte, or wall-time budget is reached.
7. If the traversal reports more work, dispatch the next batch cooperatively.
8. When one complete traversal finishes, sleep until a Motion event, boot
   recovery, or the periodic safety trigger wakes it again.

A video larger than one batch's hash-byte or wall-time budget is hashed across
cooperative batches through adapter-owned in-progress state. No descriptor is
published until the full digest and final no-follow identity check succeed.
Cancellation closes the file handle and discards the partial hash; restart may
rehash that one file from byte zero but never persists a provider-specific or
filesystem-handle value.

The completed-video port returns explicit traversal progress rather than
inferring completion from the number of valid descriptors. A directory full of
invalid, unstable, or already-known entries must still advance the cursor.

Only one recovery traversal runs at a time. Cancellation closes every retained
directory handle, and a process restart safely begins again from the root.
Files added before a cursor position or while a directory is being traversed may
wait for the next safety traversal, but cannot be lost permanently.

Wake reasons retain their identity while coalescing. A Motion-event wake during
a traversal requests one follow-up traversal because the new file may precede
the cursor. A safety wake that occurred before the current traversal completed
is satisfied by that traversal and does not immediately start another full
scan. After a safety traversal, the next safety-only traversal cannot begin
before the configured interval; Motion-event wakes may bypass that rest period.
This prevents a traversal that takes longer than two minutes from turning the
Pi into a continuous full-disk hashing loop. Registration continues while Drive
is offline.

## 7. Continuous Drive drain

`ArchiveSchedulerService` owns a single-flight drain pump. It wakes on:

- archive runtime start;
- Drive activation or recovery;
- new artifact registration;
- transfer completion or failure;
- the earliest durable retry or provider-cooldown deadline;
- the earliest folder-branch revalidation or recoverable provider-block probe; and
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

Wake-up delivery uses an in-process monotonic wake epoch. Registration, Drive
activation, settlement, and deadline expiry increment the epoch and cancel any
armed wait. Before the pump performs its final empty-queue read it snapshots the
epoch; it arms the cancellable wait first and then compares the epoch again. A
changed epoch immediately cancels the wait and repeats admission, so work
registered between the empty read and timer installation cannot be lost.

The repository exposes one bounded next-deadline projection covering attempt
retry times, artifact-admission retry times, folder-branch revalidation,
recoverable provider-block probes, and the provider cooldown. On restart,
durable queue state plus the runtime-start wake reconstructs the wait; the wake
epoch itself does not need persistence.

The scheduler stores provider-state generation ID, failure class, failure
streak, cooldown deadline, and block reason durably. Provider state is
authoritative only when its generation equals the active connection generation;
activation of another generation causes a CAS replacement before provider work
is admitted. A success clears a transient streak only when it is the same
operation class that failed,
or when it is the explicit post-cooldown probe; an unrelated successful metadata
read cannot clear an upload cooldown. A provider gate applies the state to all
Drive mutations and to provider reads other than the one CAS-claimed bounded
recovery probe authorized by the current state. Cached status, Motion, Telegram,
registration, backups, and local work do
not depend on that gate. In-process waiting is cancellable; epoch deadlines allow
restart recovery and are clamped to a configured maximum sleep when the wall
clock changes implausibly. Clamping a timer is not treated as deadline recovery.

At runtime start, after the single-instance process lock is held, one database
transaction releases every upload lease owned by an earlier process instance,
returns its attempt to schedulable retry state, and preserves any encrypted
resumable session and confirmed offset. This recovery does not depend on the
wall clock or wait for an epoch lease to appear expired.

The scheduler also compares the current wall clock with the latest durable
archive timestamp. Archive scheduler state persists the last plausible wall
time, clock-health state, observed rollback, and CAS revision independently of
provider generation. A backward jump beyond the checked-in five-minute
plausibility tolerance enters `clock-blocked`: all Drive work, retention, and
deadline-driven queue claims pause, while Motion, Telegram, registration, local
backups, status, and clock-health checks continue. In-process delays use a
monotonic clock. Once the wall clock is plausible again, one CAS clears the
clock block and wakes the pump; stored provider deadlines are never silently
rebased earlier. A forward jump makes already-passed deadlines due but still
admits only one gated provider probe or transfer.

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

Classification is reason-first. Authorization, account, and policy outcomes
override status-only resumable handling; a `403` policy rejection is never
treated merely as an expired session.

| Failure | Scope and response |
|---|---|
| Offline transport or retryable 5xx during a resumable request | Preserve the attempt and encrypted session; after backoff, query the session before sending more bytes. |
| Ambiguous chunk response | Query the resumable session before sending more bytes. |
| 403 rate-limit reason or 429 before session creation | Preserve the attempt, honor a bounded valid `Retry-After` when present, and pause provider work with truncated exponential backoff and fresh jitter. |
| 403 rate-limit reason or 429 from a resumable session request | Apply the provider cooldown, treat the session URI as unusable, reconcile the reserved exact ID, clear the session durably, and start a fresh session after cooldown only when the ID remains free. |
| 404 or another non-authorization, non-policy 4xx from a resumable session request | Treat the session URI as unusable, reconcile the reserved exact ID, clear the session durably, and start a fresh session only when the ID remains free. |
| Storage quota exhausted | Run exact-ID retention once; if the deficit remains, block uploads and alert. Persist a six-hour read-only quota-probe deadline with fresh jitter; clear the block only after current quota proves the next eligible object fits. |
| `dailyLimitExceeded` or temporary provider capacity limit | Persist a generation-scoped long cooldown, alert, and re-evaluate with one bounded probe. |
| `activeItemCreationLimitExceeded` or another account creation limit requiring user action | Persist a generation-scoped provider block and alert; do not cycle through artifacts. Only an administrator retry action or new generation may request one probe after the user fixes the account. |
| Revoked authorization or account mismatch | Suspend remote work until reauthorization or activation of a matching generation. |
| Policy rejection | Persist a provider block. An administrator retry may request one probe after policy remediation; a failed probe reinstates the block. |
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
  failure pauses all Drive mutation through the generation-scoped provider gate.

Drive failures never stop Motion recording, Telegram, registration, or local
database backups. Unverified artifact paths remain protected from automatic
local cleanup. If an extended outage causes disk pressure, the worker alerts
rather than silently deleting the only unsynced copy.

A provider, folder, or clock block is never cleared merely because an unrelated
operation succeeded. Recoverable blocks clear only through their exact bounded
probe and CAS transition; reauthorization-only blocks clear only through a new
active connection generation.

Logs and user-facing errors remain sanitized. They never include local paths,
Drive IDs, installation IDs, chat IDs, tokens, client secrets, provider response
bodies, resumable-session URIs, or bot-token-bearing URLs.

## 10. Existing flat Drive videos

There is no migration mechanism. Existing verified flat objects remain valid
under their immutable stored attempt parent and are not treated as detached
merely because new uploads use date folders.

After the new behavior is deployed and verified, the administrator may remove
old flat video objects from inside `Home Worker Archive/Motion`. The
administrator must keep `Home Worker Archive`, `Motion`, `Backups`, all date
folders, and every required local source file.

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
- drain state: active, idle, cooling down, branch-blocked, quota-blocked,
  capacity-blocked, policy-blocked, clock-blocked, or
  reauthorization-required;
- unhealthy date-folder count;
- last successful full Motion traversal;
- last successful artifact registration; and
- last successful Drive upload.

`branch-blocked` is reported only when queued motion work exists but every due
candidate is under an unhealthy branch; healthy active work takes precedence.
Provider-wide block states take precedence over branch state.

Durable deduplicated alerts cover unhealthy folder branches, prolonged provider
cooldown, storage/capacity block, reauthorization, prolonged backlog age, and
local disk pressure. Status and alerts contain no raw folder or object IDs.

`clock-blocked` takes precedence over queue or branch state while the wall clock
is implausible. For every blocked state, status provides one exact localized
required action. Quota and folder branches may recover through their bounded
automatic probes. Capacity and policy blocks offer an administrator-only retry
action that schedules one probe; it does not optimistically clear durable state.
Reauthorization-required never offers that retry action.

`/gdrive retry` and the equivalent administrator-private status action call one
`RetryDriveArchiveUseCase`. The action binds to the active generation and the
observed provider-state revision, contains no Drive or folder ID, and schedules
at most one immediate probe. For a branch-blocked queue with clear provider
state, the use case selects one unhealthy current head by durable next-check
order and CAS revision without exposing its identity. Otherwise it is accepted
only for capacity or policy blocks. Stale revisions are harmless no-ops, quota
blocks retain their automatic probe, and reauthorization-required returns the
existing connect guidance. A failed probe atomically reinstates the classified
block and its alert cooldown.

All status and admission projections remain SQL-aggregate and bounded in memory.
They never materialize every queued or retryable artifact ID in application
memory. Queue-critical indexes cover, at minimum:

- artifact kind, lifecycle state, admission state/deadline, creation time, and
  deterministic ID order;
- artifact day path for blocked-prefix admission;
- attempt generation, state, next-attempt deadline, retry order, creation time,
  and deterministic ID order;
- attempt artifact/generation/state existence checks; and
- current folder generation/state/path checks.

Infrastructure tests pin the expected SQLite query plans for large queue
fixtures. A bounded selector or status query may not fall back to a full scan of
historical verified attempts on every pump admission.

## 12. Tests

### 12.1 Domain

- valid AVI, MKV, and MP4 paths;
- MIME mapping;
- leap years and invalid calendar dates;
- invalid hour, minute, and second values;
- zero-padding, traversal, backslashes, absolute paths, unsafe filenames,
  unsupported extensions, and extra segments; and
- stable folder components independent of process timezone.

### 12.2 Application

- partial existing folder chains and exact-ID reuse;
- reservation persistence before remote create;
- restart after ambiguous create;
- duplicate candidates, rejected page tokens, and incomplete search;
- transient discovery uncertainty leaving no durable conflict head;
- database rollback with a renamed, moved, shared, trashed, or duplicated
  remote identity, without parallel-folder creation;
- renamed, moved, shared, trashed, missing, and conflicting folders;
- administrator restoration of an exact detached folder and duplicate removal
  followed by one bounded branch revalidation probe;
- failed branch probes advancing their durable deadline without provider storms;
- concurrent resolution of the same path and connection-generation changes;
- atomic current-slot replacement and immutable historical reservation rows;
- upload attempts using the verified day-folder ID;
- resumed attempts revalidating the complete folder chain;
- year, month, or day mutation after the final upload chunk but before durable
  verification, preserving the local source and refusing verification;
- missing-folder repair before session creation, during a resumable session, and
  while an attempt is retryable;
- an unhealthy oldest date branch not blocking a later healthy branch;
- backups retaining their existing destination;
- flat-object deletion producing a nested replacement attempt only when the
  trusted source survives;
- continuous next-item admission with exactly one active transfer;
- empty-queue sleep and wake-up on new work;
- registration between the final empty read and wait arming without a lost wake;
- backup priority and retry fairness during a large video backlog;
- one provider cooldown preventing a backlog-wide failure storm;
- an unrelated successful metadata read not clearing an upload cooldown;
- activation of a new connection generation clearing stale generation-scoped
  cooldown or block state;
- phase-specific resumable 4xx handling and exact-ID reconciliation before a
  replacement session;
- quota, authorization, policy, cancellation, and restart behavior;
- quota recovery through a bounded read-only probe, administrator retry for
  capacity/policy blocks, and reauthorization-only admission remaining closed;
- `/gdrive retry` generation/revision fencing, one-probe scheduling for branch,
  capacity, and policy recovery, stale-action no-op behavior, and refusal during
  reauthorization-required;
- restart with a large backward wall-clock jump releasing previous-process
  leases without admitting provider work until clock health returns;
- a large forward wall-clock jump preserving single-probe/single-transfer
  admission; and
- maintenance work continuing beside a stalled transfer.

### 12.3 Camera recovery

- more than 64 videos across multiple date folders and one very large day
  directory without unbounded `readdir` or sort behavior;
- invalid and unstable files mixed with valid files;
- already-known files skipped before hashing;
- entry, hash-byte, wall-time, and memory bounds for one batch;
- explicit cursor progress when a batch yields no valid descriptors;
- cooperative continuation to traversal completion;
- event and periodic wake-up coalescing;
- a traversal longer than the safety interval not causing continuous safety-only
  rescans, while a Motion-event wake still schedules one follow-up traversal;
- cancellation; and
- idempotent restart from the root.

### 12.4 Infrastructure and composition

- Drizzle reservation constraints, CAS behavior, restoration, and generated
  migration coverage;
- artifact admission state, blocked-branch selection, provider-state generation,
  and next-deadline projection persistence;
- large-fixture SQLite query-plan coverage for admission, deadlines, status, and
  blocked-prefix selection, with aggregate reads bounded in application memory;
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
4. Confirm the exact `Home Worker Archive/Motion/YYYY/MM/DD/filename` hierarchy.
5. Restart during a resumable upload and confirm continuation or safe session
   replacement.
6. Rename one date folder during an upload and confirm the object is not accepted
   as verified, the local file remains, and restoring the exact folder allows a
   bounded branch probe to resume the backlog.
7. Remove one duplicate date-folder candidate and confirm a blocked branch
   recovers without creating another parallel folder.
8. After verifying the matching local source exists, remove one old flat Drive
   video and confirm nested replacement.
9. Confirm database backups, Motion, Telegram, status, and local cleanup remain
   responsive throughout the drain.

## 13. Acceptance criteria

- Every newly uploaded valid motion video uses its exact local `YYYY/MM/DD`
  hierarchy below the existing managed `Motion` folder.
- Every surviving valid video recorded during an outage eventually registers
  and uploads after recovery.
- The uploader admits the next eligible artifact immediately after settlement,
  subject to backup fairness and Drive cooldowns.
- A detached or conflicting date branch cannot repeatedly win admission or block
  a later healthy date branch.
- Transient incomplete discovery cannot permanently poison a date branch, and a
  corrected detached or duplicate branch can recover through exactly one
  bounded revalidation path without automatic remote mutation.
- Work registered while the pump is becoming idle is admitted without waiting
  for the periodic safety tick.
- At most one media upload is active.
- Folder and object IDs are durable before ambiguous remote mutations.
- Restoring an older database cannot make the worker create a parallel folder
  beside a surviving renamed, moved, shared, duplicated, or trashed exact
  remote identity.
- Folder replacement never changes an attempt's immutable container; an
  incompatible pending or retryable attempt is reconciled and replaced by an
  exact-ID transaction.
- Restarts preserve folder resolution, retry deadlines, attempts, and resumable
  progress.
- Restart recovery releases leases owned by the previous single process without
  trusting a rolled-back wall clock; implausible time blocks provider work but
  never blocks local recording, registration, backups, Telegram, or status.
- An uploaded object becomes verified only after the complete date-folder chain
  passes a second exact validation after transfer.
- Provider cooldown and block state applies only to its recorded active
  connection generation and cannot be cleared by an unrelated successful call.
- Recoverable folder, quota, capacity, and policy blocks resume only through
  their exact CAS-fenced bounded probe; revoked authorization and account
  mismatch remain closed until a matching generation is activated.
- Rate limits and retryable server failures produce bounded exponential backoff,
  not a request storm.
- Existing flat objects are neither moved nor automatically deleted.
- A manually removed flat object is recreated only from a surviving unchanged
  local source.
- Database backups and non-Drive runtime behavior remain available during
  backlog drain and Drive failure.
- Filesystem discovery is bounded by entries, bytes, wall time, and memory; a
  safety traversal longer than its interval cannot create a continuous rescan
  loop, and already-known files are rejected before hashing.
- Queue admission, deadlines, blocked-prefix selection, and aggregate status use
  indexed, bounded-memory database operations at large backlog sizes.

## 14. Primary references checked

- [Google Drive: upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive: usage limits](https://developers.google.com/workspace/drive/api/guides/limits)
- [Google Drive: resolve errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)
- [Google Drive: create and populate folders](https://developers.google.com/workspace/drive/api/guides/folder)
- [Google Drive: search for files and folders](https://developers.google.com/workspace/drive/api/guides/search-files)
- [Google Drive: custom file properties](https://developers.google.com/workspace/drive/api/guides/properties)
- [Google Drive: generate IDs](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds)
- [Motion movie configuration](https://motion-project.github.io/motion_config.html)

These references were checked on 2026-08-13 and rechecked through the current
official Drive documentation on 2026-08-27. Runtime error classification,
rather than fixed numeric quota assumptions, remains authoritative.

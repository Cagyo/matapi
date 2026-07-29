# Google Drive API Sync

> **Date:** 2026-07-29
> **Status:** pressure-tested design; awaiting final written-spec review
> **Scope:** replace the unused rclone integration with installation-owned Google OAuth, direct Google Drive API uploads, bounded retention, and Telegram-managed setup for completed Motion videos and SQLite backups

## 1. Goal

Home Worker uploads two kinds of completed artifacts to a private Google Drive:

- completed Motion event videos; and
- completed SQLite database backup snapshots.

The local filesystem is the source of truth and Google Drive is a one-way archival slave. A local artifact may create or repair its Drive copy. A local deletion never propagates to Drive. A remote deletion never deletes the local copy.

The integration must remain usable for nontechnical third-party installers:

1. the installer creates an OAuth client in their own Google Cloud project;
2. they send the downloaded client JSON to the bot in a private admin chat;
3. the bot guides the Google device authorization flow;
4. the bot confirms the selected account and creates the Drive folders; and
5. normal uploads, retention, status, alerts, and reauthorization require no SSH or manual configuration.

The design does not promise an OAuth credential that literally never expires. It provides the closest supported behavior: an offline refresh token from a production OAuth project, persisted and refreshed automatically. Sync can still require reauthorization if the user revokes access, deletes or disables the OAuth client/project, changes account or organization policy, exhausts Google's refresh-token limits, leaves a token unused long enough for Google to expire it, or Google otherwise returns a permanent authorization failure.

## 2. Approved decisions

- Use `@googleapis/drive` for Drive metadata, folder, quota, listing, generated-ID, non-media creation, and deletion operations. The resumable media protocol is implemented through the bounded direct-HTTPS adapter described below.
- Use `google-auth-library` for OAuth credentials and automatic access-token refresh.
- Use direct HTTPS only for Google's allowlisted OpenID discovery, limited-input device authorization, token-revocation, and resumable-upload endpoints.
- Request only the non-sensitive `https://www.googleapis.com/auth/drive.file` scope.
- Give every Home Worker installation its own Google Cloud project and OAuth client of type **TVs and Limited Input devices**.
- Accept the OAuth client JSON only as a small Telegram document sent by an administrator in a private chat.
- Automatically create `Home Worker/motion` and `Home Worker/backups`.
- Upload only completed Motion event videos and completed database backups. Do not upload snapshots, thumbnails, partial recordings, live streams, logs, or arbitrary files.
- Stream uploads with installation-wide transfer concurrency one to stay below the Raspberry Pi memory limit. Do not hold a global application mutex for the duration of a network transfer.
- Separate stable local artifacts from immutable Drive object attempts. A local artifact may have several historical remote attempts, but each reserved Drive ID is append-only and permanently auditable.
- Persist resumable-upload sessions in encrypted durable state and resume or reconcile them after restart.
- Use short database leases and compare-and-swap transitions for crash recovery and fencing; use narrow locks only where two local mutations truly conflict.
- Use exact Drive file IDs. Do not infer ownership from folder names or paths.
- Permanently delete only exact, validated file IDs recorded as artifacts created by this installation.
- Never empty Google Drive Trash and never delete an unrelated Drive file.
- Keep Drive backups for seven days while their connection generation remains active and manageable. Retired-generation archives are preserved for manual review.
- Keep videos indefinitely while quota permits and their generation remains active and manageable. Under quota pressure, apply the bounded cleanup policy in section 13.
- Treat moved, shared, ownership-changed, or content-replaced remote artifacts as detached and preserve them.
- Replace, rather than migrate, the unused rclone integration. Remove its repository leftovers without touching unrelated host or Drive state.
- Upgrade the supported runtime to Node.js 22 LTS as a prerequisite because Node.js 20 is end-of-life by the implementation date.
- Treat Drive `permissionId` as the stable Google account identifier. Email address and display name are optional presentation metadata.
- Retire replaced connection generations explicitly: remove superseded OAuth secrets from live logical state, preserve non-secret audit rows and remote data, and tell the administrator when an older archive is no longer automatically manageable.

## 3. Non-goals

This feature does not provide:

- bidirectional filesystem synchronization;
- restoration or browsing of backup contents;
- upload of incomplete Motion recordings;
- migration of rclone state or rclone-created Drive files;
- deletion of arbitrary files found by name, folder, age, MIME type, or extension;
- deletion of anything in the user's general Drive Trash;
- automatic cleanup of system-wide rclone binaries or user-owned rclone configuration;
- Google Workspace domain-wide delegation;
- a vendor-hosted OAuth broker;
- service-account storage;
- multi-cloud support;
- deduplication across different installations or Google accounts; or
- a guarantee that Google will never revoke a refresh token.

## 4. Third-party setup options

### 4.1 Installation-owned OAuth client — selected

The third-party user flow is:

1. In a private bot chat, an administrator runs `/gdrive connect`.
2. The bot shows a short, localized checklist:
   - open Google Cloud Console;
   - create or select a project dedicated to this Home Worker installation;
   - enable the Google Drive API;
   - configure an External OAuth consent screen;
   - publish the app to **In production**;
   - create an OAuth client of type **TVs and Limited Input devices**; and
   - download the client JSON.
3. The administrator sends the JSON as a Telegram document in the same private chat.
4. The bot deletes that Telegram message on a best-effort basis, validates and encrypts the credentials, and starts Google's device authorization flow.
5. The bot shows Google's verification URL and user code.
6. The administrator opens the URL on any device, signs in to the intended Google account, reviews the `drive.file` permission, and approves it.
7. The bot polls Google at the instructed interval.
8. The bot reads the authorized Drive account identity and asks the administrator to confirm it.
9. After confirmation, the worker creates or reuses its managed folders, activates the connection atomically, and reports success.

Security properties:

- compromise, deletion, quota enforcement, or policy changes in one installation's Cloud project do not invalidate every other installation;
- no vendor-operated client secret or token service becomes a fleet-wide target;
- the user can independently revoke or delete the project; and
- the consent screen, API quota, and project lifecycle stay under the installation owner's control.

This is better compartmentalization, not secret encapsulation. A client secret shipped to an installed-device application cannot be treated as confidential, and a compromised Pi can read the tokens needed by that Pi. The main security benefit is limiting fleet-wide blast radius and avoiding a central authorization service.

### 4.2 Vendor-owned shared OAuth client — rejected

The alternative third-party flow would be shorter:

1. an administrator runs `/gdrive connect`;
2. the bot immediately shows a Google device code;
3. the administrator authorizes the vendor's published app and confirms the account; and
4. the worker creates folders and begins syncing.

This removes Google Cloud setup from each installation, but one project, consent screen, client, quota, policy decision, or compromise affects the whole fleet. The client credentials would still be recoverable from distributed installations. A public multi-user app may also acquire verification, support, privacy-policy, and publisher-maintenance obligations. This option is therefore outside the selected self-hosted model.

A service account is also rejected. It complicates personal Drive ownership and folder sharing, introduces another private key, and does not improve the simple one-user device flow.

## 5. Architecture

Drive archival is a separate `archive` bounded context. The existing rclone implementation happens to live under `camera`, but this replacement is a meaningful change and must not make the camera context permanently own generic OAuth credentials, account quota, database backup scheduling, and remote retention.

- `camera` owns Motion completion, completed-video validation, and local media lifecycle.
- `database` owns creation and local retention of consistent SQLite backup snapshots.
- `archive` owns Google authorization, the durable archival queue, Drive folders and objects, upload attempts, remote reconciliation, remote retention, and Drive status.
- `telegram` invokes published archive application use cases.

Cross-context calls use published application ports. Camera registers a completed video with the archive context. The archive scheduler requests a completed database snapshot through a database-owned backup port. Camera local cleanup queries an archive verification port rather than reading archive tables directly.

New code follows the repository's hexagonal layout:

```text
src/archive/
  domain/
    drive-connection.ts
    archive-artifact.ts
    drive-object-attempt.ts
    errors/
  application/
    ports/
      drive-device-authorization.port.ts
      drive-credential-repository.port.ts
      drive-account.port.ts
      drive-archive.port.ts
      archive-artifact-repository.port.ts
      archive-registration.port.ts
      archive-verification.port.ts
      archive-clock.port.ts
    use-cases/
      connect-drive.use-case.ts
      disconnect-drive.use-case.ts
      register-archive-artifact.use-case.ts
      upload-drive-object-attempt.use-case.ts
      reconcile-drive.use-case.ts
      apply-drive-retention.use-case.ts
      report-drive-status.use-case.ts
  infrastructure/
    google/
    persistence/
    scheduling/
src/database/
  application/
    ports/
      database-backup-snapshot.port.ts
```

The exact file split may be adjusted during implementation, but dependencies must point inward:

- Telegram commands call application use cases.
- Schedulers call application use cases.
- Application code depends on ports and domain values, not Google SDK classes or Drizzle.
- Google and database details remain infrastructure adapters.
- Google failures are mapped to typed, provider-neutral application errors before crossing an adapter boundary.
- Error classes follow the repository convention of one typed class per file under `domain/errors/`.

The main ports are:

- `DriveDeviceAuthorizationPort`: requests and polls a device code, producing OAuth credentials or typed authorization failures;
- `DriveCredentialRepositoryPort`: stages, encrypts, activates, reads, and invalidates connection credentials;
- `DriveAccountPort`: resolves account identity, quota, and managed folder state;
- `DriveArchivePort`: generates IDs, uploads, verifies, reads metadata, reconciles, and permanently deletes managed objects;
- `ArchiveRegistrationPort`: accepts completed video and backup descriptors without exposing archive persistence;
- `ArchiveVerificationPort`: answers whether one local artifact has a current cleanup-safe Drive attempt;
- `DatabaseBackupSnapshotPort`: is published by the database context and creates or locates a completed local snapshot; and
- `ArchiveClockPort`: supplies wall time and a synchronized/plausible health result for retention decisions.

Coordination is deliberately split:

- a transfer semaphore permits one active Drive byte transfer installation-wide;
- each Drive object attempt is claimed through a durable lease with an expiry and compare-and-swap revision;
- connection activation increments a durable connection revision, and every credential or token write is fenced by generation and revision;
- remote retention and reconciliation use a short remote-mutation lock while selecting and validating exact IDs, but do not hold it while waiting for unrelated local backup work;
- local cleanup excludes only artifacts currently hashing, uploading, or reconciling; and
- scheduler-level non-overlap remains a secondary guard.

A long or stalled video transfer therefore cannot prevent SQLite snapshot creation, candidate registration, status reporting, or cleanup of unrelated local media. Backup uploads still receive the next transfer slot before video uploads.

## 6. Durable state

### 6.1 Drive connections

The database stores durable connection generations rather than a single mutable credential blob. A connection records:

- internal generation ID and status: `staged`, `active`, `reauth_required`, `retiring`, `retired_unmanaged`, `disconnecting`, or `disconnected`;
- a compare-and-swap revision used to fence activation and token refresh writes;
- a non-secret hash of the OAuth client ID for matching reconnects;
- encrypted OAuth client and token material;
- confirmed Google Drive `permissionId`, plus optional email address and display name;
- stable Drive IDs for the root, motion, and backup folders;
- creation, activation, last-refresh, and last-success times;
- last typed error and alert-cooldown state; and
- quota reclamation bytes and accounting-window timestamps.

At most one generation is active. A reconnect is staged and fully validated before it can replace the active generation. Failure, cancellation, denial, timeout, wrong-account rejection, or folder-creation failure leaves the previous active generation unchanged.

Reauthorization with the same OAuth client and confirmed `permissionId` reuses the existing archive generation and folder IDs. Activation replaces the credential envelope with a revision-checked write and removes the superseded envelope from live logical state. A delayed refresh event from an older OAuth client instance cannot update the new revision.

A different client/project or a different `permissionId` starts a new generation. Before confirmation, the bot warns that the previous generation's Drive files will remain preserved but may no longer be visible or manageable through the new `drive.file` grant. Atomic activation makes the new generation active and the previous one `retiring` in the same transaction. A durable retirement job then makes one best-effort revocation attempt against the old refresh token, removes the old client and token material from live logical state, and marks the generation `retired_unmanaged`. Boot recovery completes any interrupted `retiring` job before normal Drive scheduling. Revocation failure is reported but does not roll back the new active generation or retain the old secret indefinitely. The non-secret manifest and exact Drive IDs remain as audit history, and old remote files are never adopted into the new generation merely because folder names or metadata match.

Automatic seven-day backup retention and quota cleanup apply only while a generation is active and manageable. Status reports retired generations and tells the administrator that their preserved remote files require manual review. The worker never retains credentials to an old account merely to continue background deletion.

An artifact whose current verified attempt belongs to a retired generation cannot authorize later local cleanup or remote deletion. If its local source still exists and is trusted, the new active generation creates a new attempt before that local copy becomes cleanup-eligible. If the local source is already gone, the old remote copy remains a preserved, unmanaged archive.

`/gdrive disconnect` is a private, admin-only, confirmed operation. A transaction marks the active generation `disconnecting`, which fences new Drive work. The worker cancels active requests, clears live attempt leases and resumable sessions for the generation, makes one best-effort token-revocation attempt, removes local OAuth secrets from live logical state, and marks the generation `disconnected`. Boot recovery completes an interrupted `disconnecting` job. Every local file, remote file, artifact row, and non-secret audit field is preserved. A revocation failure is reported but never causes local secrets to be retained indefinitely.

### 6.2 Drive objects

Durable state separates the local artifact from its remote attempts.

Every local artifact has one durable row with:

- object kind: `motion_video` or `database_backup`;
- lifecycle state such as `stabilizing`, `pending`, `verified`, `local_missing`, or `superseded`;
- owning installation ID;
- local source identity, optional trusted local path, size, and source timestamp;
- a streaming SHA-256 content digest;
- a stable source fingerprint;
- an optional current verified-attempt ID; and
- created, updated, and local-deletion timestamps.

Every Drive object creation or replacement has a separate immutable attempt row with:

- owning artifact ID and connection generation;
- lifecycle state such as `pending`, `uploading`, `retryable`, `verified`, `missing`, `detached`, `conflict`, `abandoned`, or `deleted`;
- a pre-generated Drive file ID that is never overwritten or reassigned;
- expected remote parent folder ID;
- verified remote size, SHA-256 checksum, optional MD5 checksum, server `createdTime`, binary `headRevisionId`, observed file `version`, canonical sharing state, and private `webViewLink`;
- encrypted resumable-session URI, session creation and expiry times, and last confirmed byte offset;
- lease owner, lease expiry, and compare-and-swap revision;
- retry count, next attempt, and last typed error;
- detached or missing reason; and
- created, updated, uploaded, verified, and deletion timestamps.

Multiple Motion event records may reference the same artifact and its current verified attempt. The current `gdriveFileId` behavior, which stores a remote path rather than a Drive ID, is removed instead of migrated.

The local source fingerprint is stable for hook retries and reconciliation. It is a SHA-256 digest over a canonical tuple containing the installation ID, artifact kind, normalized path relative to the kind's exact managed root, stable file size, nanosecond modification time, and streaming SHA-256 content digest. The managed root is the configured Motion root for videos and the database-owned backup staging root for snapshots. The file is re-statted after hashing; any change discards the digest and restarts stabilization. The raw path remains local for upload, but only the fingerprint and content digest are copied into Drive `appProperties`.

The database enforces uniqueness for the canonical source fingerprint and reserved Drive ID. Queue and reconciliation indexes cover state plus next-attempt time, expired leases, connection generation, and current verified attempt. State-transition checks prevent a verified attempt without verified metadata and prevent two current verified attempts for one artifact.

An artifact can accumulate several attempt rows after an ambiguous outcome, missing remote object, content conflict, or connection replacement. Old attempt IDs remain auditable forever. Creating a replacement never overwrites the ID or verification metadata of an earlier attempt.

## 7. Credential handling

The installer creates a random 256-bit encryption key outside the application release directory, for example under `/etc/home-worker/`, with ownership and permissions that allow only root and the Home Worker service account to read it. Reinstallation and OTA never overwrite an existing key.

OAuth client data, refresh tokens, access-token state, staged post-exchange credentials, and resumable-session URIs are encrypted at rest using authenticated AES-256-GCM with a versioned envelope and fresh nonce. Additional authenticated data binds each envelope to the installation ID, connection generation or object-attempt ID, credential kind, and schema version so a valid ciphertext cannot be transplanted between rows or fields. The database stores ciphertext, nonce, authentication tag, key version, and format version. Secrets are never logged, placed in error strings, included in status output, or sent back to Telegram.

Uploaded client JSON is parsed from a bounded in-memory buffer and is never written to a plaintext temporary file. Logical deletion of a credential envelope does not claim physical erasure from SQLite pages, WAL history, flash wear-leveling, Telegram infrastructure, or backups. The security boundary is encryption under the installation key plus prompt removal of live references and future access.

If the encryption key is missing, unreadable, or fails authentication, Drive becomes `reauth_required`. The worker continues Motion, Telegram, local recording, and local backups. It does not silently replace the key, discard the manifest, delete remote data, or repeatedly attempt OAuth with corrupt credentials.

Google credential refresh events are merged into the stored token set through a compare-and-swap update bound to the active generation and connection revision. An event that omits `refresh_token` must retain the previously stored refresh token. A late event from an old client or revision is discarded. A permanent refresh failure such as `invalid_grant` causes one controlled transition to `reauth_required` and a rate-limited admin alert; it must not produce a refresh loop.

The OAuth device code exists only in bounded process memory. Boot maintenance expires every staged authorization and removes its encrypted client, post-exchange token, and workflow material while leaving any previous active generation unchanged. A process restart does not resume device polling or account confirmation: the staged workflow becomes interrupted, its secrets are removed from live state, and the administrator starts `/gdrive connect` again.

## 8. Telegram authorization workflow

Only an authenticated administrator in a private chat may start or interact with Drive authorization. Group chats, channels, non-admin users, forwarded documents, and unrelated Telegram documents are rejected without parsing their contents.

The bot accepts one pending Drive authorization installation-wide. The workflow is bound to:

- the initiating administrator;
- the initiating private chat;
- a random workflow receipt;
- a creation and expiry time; and
- the staged connection generation.

Callbacks and documents must match all bindings. Competing administrators receive a clear “setup already in progress” response. Stale callbacks are harmless.

The OAuth client JSON:

- must be sent as a Telegram document;
- must be at most 64 KiB, well below Telegram's bot download limit;
- must parse as one expected Google installed-device/limited-input credential shape;
- must contain syntactically valid `client_id` and `client_secret`;
- must not contain unknown executable configuration; and
- must never control a URL used by the worker.

The bot checks Telegram's declared document size before download and also enforces a 64 KiB streaming byte limit if the size is absent or inaccurate. It aborts as soon as the limit is exceeded. Telegram download URLs contain the bot token and are redacted from HTTP errors, tracing, and structured logs.

The worker hardcodes Google's HTTPS OpenID discovery-document URL and reads `device_authorization_endpoint` and `token_endpoint` from that document. It accepts only the expected `https://oauth2.googleapis.com` origin and an explicit device-code/token path allowlist, rejects cross-origin redirects, and fails closed if discovery is unavailable or unexpected. It ignores authorization, token, redirect, certificate, or discovery URLs supplied by the uploaded JSON, preventing the document from becoming an SSRF or credential-exfiltration vector.

After reading the document, the bot attempts to delete the incoming Telegram message. Authorization may continue if deletion fails, because message deletion can fail due to age, platform rules, or transient errors, but the bot warns the administrator to delete it manually.

Deleting the Telegram message is exposure reduction, not a claim of cryptographic erasure from Telegram infrastructure or every client cache. The installed-device client secret is not treated as a confidential security boundary. OAuth access and refresh tokens are never sent through Telegram.

The device flow requests only `drive.file`. The worker displays Google's returned verification URL and user code, then polls at Google's returned interval. It handles:

- authorization pending;
- `slow_down` by increasing the interval;
- access denial or cancellation;
- expired device code;
- invalid client;
- organization administrator policy;
- rate limiting;
- temporary network or Google failures; and
- overall workflow expiry.

The polling loop is cancellable and survives Telegram updates without blocking the bot. It is not resumed across a process restart. Raw device codes, access tokens, refresh tokens, client secrets, Telegram file URLs, and resumable-session URLs are redacted from logs.

After token exchange, the worker reads the Drive account identity and asks the initiating administrator to confirm it. The stable identity is Drive `permissionId`; email address and display name are shown only when present and are never used for same-account matching. Rejection discards the staged credentials. Confirmation causes folder resolution and atomic activation.

Cancellation, denial, expiry, role loss, wrong-account rejection, folder failure, and restart all remove staged live credential references and terminate the exact workflow receipt. None of them mutate or disable the previous active generation.

The bot explicitly warns that an External consent screen left in **Testing** normally produces a seven-day refresh-token lifetime for Drive authorization. The setup checklist requires **In production**. Google does not expose a reliable runtime signal that lets this worker prove the publishing status, so this remains a documented user step.

## 9. Managed folders and ownership

The active generation uses:

```text
My Drive/
  Home Worker/
    motion/
    backups/
```

Stable Drive folder IDs, not names, are authoritative after activation. Folder creation is idempotent:

1. use a stored folder ID when it still exists, is not trashed, is owned by the authorized account, has the expected MIME type and parent, remains private, and remains accessible to this OAuth client;
2. otherwise search only the `user` corpus and `drive` space for app-created folders with matching private `appProperties`, `trashed = false`, and the expected parent;
3. paginate through every result page and fail closed if Drive reports `incompleteSearch`;
4. if Google rejects a page token, restart that bounded listing once from the first page;
5. reuse a candidate only when exactly one valid candidate exists;
6. if several valid candidates exist, preserve all of them, mark folder resolution ambiguous, and require administrator review rather than selecting one arbitrarily; and
7. if no candidate exists, pre-generate and persist a folder ID before creation, then resolve an ambiguous response by fetching that exact ID.

A matching folder name alone never establishes ownership. Duplicate names are allowed in Drive and must not cause adoption.

Each app-created folder and artifact receives private `appProperties` containing:

- installation ID;
- connection generation;
- object kind;
- source fingerprint for artifacts;
- SHA-256 content digest for artifacts;
- capture or backup time;
- application schema version; and
- a role marker for managed folders.

Keys and values use a versioned compact encoding that stays within Drive's limit of 30 private properties per application and 124 UTF-8 bytes for each key-plus-value pair. Values that exceed their bound are hashed locally; unbounded paths, names, email addresses, and error text are never stored in `appProperties`.

These properties support recovery after database restoration, but do not authorize deletion by themselves. Permanent deletion additionally requires matching durable artifact and immutable attempt rows, an active manageable generation, expected object kind, verified ownership, and exact file ID.

## 10. Motion completion and recovery reconciliation

Motion continues to call its `on_movie_end` hook. This hook runs after the movie is closed, but the worker still applies a one-minute stability window because delayed filesystem writes, hook delivery races, filesystem latency, and process interruption occur in real installations.

An upload candidate must:

- be a regular, nonempty file;
- be contained within the configured Motion root after safe path resolution;
- not be a symlink;
- match the configured Motion directory and completed-video filename shape;
- have unchanged size and modification time across the stability window; and
- produce a streaming SHA-256 digest without changing size or modification time during the hash pass; and
- correspond to a completed event or be registered by the recovery reconciliation described below.

Hook retries are idempotent through the source fingerprint. If multiple event rows point to the same stable file, they reference one artifact and its current attempt rather than uploading duplicate bytes.

The existing Motion hook endpoint deliberately acknowledges errors to avoid destabilizing Motion. Therefore the worker also performs a bounded boot-time and periodic reconciliation:

1. scan only the configured Motion root;
2. ignore symlinks, partial files, unexpected extensions, invalid paths, empty files, and unstable files;
3. match only the expected Motion-generated path and filename pattern;
4. hash each stable candidate with bounded buffers and re-stat it;
5. skip every resulting source fingerprint already known to the database;
6. register a stable unreferenced file as a standalone completed Motion event; and
7. let the normal database-led upload flow handle it.

Reconciliation never directly uploads an arbitrary unreferenced file. This preserves the database as the operational queue while recovering real completed videos whose HTTP completion hook was lost during a restart or network failure.

## 11. Upload protocol

Uploads are per-object and streaming. The worker never performs a bulk directory copy and never buffers a video in memory.

For each pending artifact:

1. claim or create one Drive object attempt through an expiring database lease;
2. confirm that the claimed connection revision and expected folder are healthy;
3. validate and stat the local source and confirm its stored SHA-256 content digest;
4. acquire the installation-wide transfer semaphore;
5. generate and persist a Drive file ID before starting the first network request;
6. initiate a resumable upload using that ID and managed metadata;
7. encrypt and persist the returned session URI, initiation time, a conservative local expiry derived from Google's documented session lifetime, and the initial offset before transferring bytes;
8. stream the immutable source from one open file descriptor in bounded 256 KiB-multiple chunks with explicit request timeouts, renewing the attempt lease and persisting server-confirmed offsets;
9. on apparent success, fetch remote metadata by the reserved ID;
10. verify remote size and SHA-256 checksum, with MD5 retained only as an additional provider diagnostic;
11. require private canonical sharing state and compare the remote binary `headRevisionId` with the creation result;
12. re-stat the local source and confirm it did not change during upload;
13. atomically mark the attempt `verified`, point the artifact at that attempt, and clear the encrypted session state; and
14. release the transfer semaphore and lease.

The upload path computes a streaming SHA-256 over the exact bytes represented by the transfer. When resuming at a nonzero offset, it re-reads the local prefix into the hasher without sending it, then hashes the remaining bytes as they are sent. The completed transfer digest must equal both the artifact digest and Drive's SHA-256 metadata. No whole file is buffered. If the exact transferred bytes differ from the artifact digest, the attempt becomes `conflict`, its remote ID is preserved, and the local artifact returns to stabilization for a later attempt.

Resumable session URIs are durable because Google sessions can outlive a worker process. On boot or after an expired attempt lease, the worker:

1. loads the encrypted session URI when it remains within its bounded lifetime;
2. sends the protocol's empty status `PUT`;
3. treats `200` or `201` as complete and verifies the reserved ID;
4. treats `308` as incomplete and resumes from the server-confirmed `Range`, never merely from the locally stored offset;
5. treats `404` or an expired session as requiring a new session; and
6. clears session state only after the attempt is verified, proved unusable, or terminally classified.

If no session survives, the worker fetches the reserved ID before opening a replacement session. It reuses that ID only when Google permits it. Otherwise it terminally classifies the old attempt and creates a new attempt with a new reserved ID; it never overwrites the old attempt row.

Ambiguous outcomes are resolved by reading the reserved ID:

- if upload creation timed out but the file exists with matching metadata, size, and checksum, finish verification;
- if a retry reports an ID conflict, fetch and verify that ID;
- if no file exists, restart with the same reserved ID when Google permits it or terminally classify that attempt and create a replacement attempt only after proving the original ID is unused or unusable;
- if the ID exists but does not match, mark that attempt as a typed conflict, preserve its exact ID and remote data, return the local artifact to stabilization, and create a later attempt only after a stable content digest is available; and
- if the worker dies with state `uploading`, lease expiry—not an in-memory flag—makes the attempt recoverable.

The worker sets connect, response, idle-progress, and total-operation deadlines. An upload that stops making progress is aborted and becomes retryable. Retryable Google failures use capped exponential backoff with jitter. One failing object does not prevent later scheduler cycles from considering other eligible objects.

Database backups have priority over videos. Within videos, newer completed events are attempted before old backlog, while bounded fairness periodically admits an older retry so a transiently failed file is not starved forever.

## 12. Database backups

The database-owned backup port uses `better-sqlite3.backup` to create a consistent snapshot into an immutable, timestamped temporary path on the same filesystem as the final staging path. It validates the completed snapshot with SQLite `PRAGMA quick_check`, flushes the file and containing directory, and atomically renames it. Only then does the archive context register it as an upload candidate.

The scheduler records the last successful backup in durable state. At boot and on periodic checks, it creates a catch-up backup when no backup succeeded during the previous 24 hours. This avoids missing a day after downtime, process restarts, daylight-saving changes, or a skipped cron invocation.

The scheduled timezone is the configured IANA timezone. A durable backup-job compare-and-swap guard prevents duplicate snapshots. Backup creation does not acquire the Drive transfer semaphore and can run while a video uploads. Backup upload, remote retention, and local cleanup coordinate through attempt leases and artifact pins rather than one global mutex.

Incomplete backup `.tmp` files are never uploaded. Startup maintenance removes stale temporary backup files only from the exact application-managed backup staging directory and only when no live operation references them.

Drive backup copies expire seven days after Google Drive's server-provided `createdTime`. Age-based deletion runs only when `ArchiveClockPort` reports a synchronized and plausible system clock. If `createdTime` is missing or invalid, or clock health is uncertain, deletion fails closed and alerts. Local source time remains useful for display and ordering only when it falls within the configured clock-skew bound. Drive `modifiedTime` is not a retention clock because user or provider changes can extend it.

Local backup retention remains the responsibility of the database context, but it must pin every snapshot whose artifact has no current verified Drive attempt. It may remove a pinned snapshot only through an explicit local-emergency policy that records the loss and alerts. A Drive failure never prevents creation of a local backup.

## 13. Video retention and quota overflow

Video retention is quota-driven rather than a fixed deletion sweep:

- while usable Drive quota remains, verified managed videos stay in Drive regardless of age;
- videos older than 90 days are the normal quota-reclamation candidates;
- a sole remote copy younger than 90 days is protected;
- when space is still required, an oldest younger Drive video may be deleted only if a currently verified, unchanged local master copy exists; and
- if eligible app-created data cannot provide enough space, the worker preserves data, pauses affected uploads, and alerts the administrator.

Quota cleanup order is:

1. expired managed Drive backups older than seven days;
2. verified managed Drive videos older than 90 days, oldest first; and
3. verified managed Drive videos younger than 90 days, oldest first, only when a trusted local master copy exists.

The retention age of a video is measured from Drive server `createdTime`. Local capture time is used for presentation and queue ordering only when it falls within the configured clock-skew bound. Missing provider time or unhealthy `ArchiveClockPort` state fails deletion closed. `modifiedTime` is ignored.

Google quota can be exhausted by unrelated Drive data that Home Worker is not permitted to delete. Storage overflow must not block the worker:

- Motion continues recording subject to local disk policy;
- Telegram and other home automation continue operating;
- local database backups continue;
- upload candidates remain durable and retryable;
- the transfer semaphore and remote-mutation lock are released promptly after a quota decision;
- alerts are rate-limited; and
- status explains whether Drive, Drive Trash, or unrelated account usage appears to consume the quota.

Google may take 48–72 hours to reflect deleted bytes in quota accounting. To prevent a deletion cascade:

1. compute the upload deficit from quota values and the pending artifact's size;
2. select only enough eligible objects to cover the calculated deficit;
3. permanently delete those exact verified-attempt IDs;
4. persist the reclaimed byte total and accounting-window start;
5. do not delete another batch solely for the same quota deficit during the 72-hour accounting window;
6. retry a pending real upload at a bounded interval instead of creating artificial files;
7. end the window early when quota or a successful upload proves accounting caught up; and
8. after the window, refresh quota and calculate a new bounded batch if still necessary.

If Drive reports quota as unavailable or internally inconsistent, cleanup fails closed: uploads wait, and no speculative deletion occurs.

## 14. Permanent deletion safety

Home Worker uses Drive's permanent file deletion only. It does not move managed objects to Trash and never calls the global empty-trash API.

Before each deletion, the worker re-reads the exact Drive ID and verifies:

- a durable immutable attempt row identifies it as created by this installation;
- the connection generation is active and allowed to manage it;
- Drive reports the expected `appProperties`;
- the authorized account still owns it;
- it is not trashed;
- it has the expected artifact kind and MIME type;
- it remains in the expected managed parent folder;
- its size, SHA-256 checksum, and binary `headRevisionId` match the last verified upload;
- its file `version` matches the last accepted reconciliation state;
- its sharing state still matches the private state recorded after upload;
- `ownedByMe`, the owner's `permissionId`, and `capabilities.canDelete` still authorize deletion; and
- its state is neither detached nor subject to an active upload.

Any mismatch changes the object to `detached` or a typed investigation state and preserves it. Batch deletion by query, filename, extension, folder traversal, or age alone is forbidden.

Canonical private sharing state records the owner `permissionId`, `shared` flag, and sorted permission IDs visible to the owner immediately after upload. A later difference fails deletion closed. Permission display names and email addresses are not identity fields.

Drive's file-delete method does not expose a documented revision precondition, so it cannot make the final metadata read and deletion atomic against a simultaneous user edit. The worker minimizes this residual provider race by performing the metadata check immediately before deletion under the short remote-mutation lock. Even in that narrow race, the exact ID still identifies an object originally created by this installation; the worker can never switch to or delete a different file by name.

Unknown or malformed app-created objects found during reconciliation are preserved. A restored database may discover them, but adoption requires an unambiguous match among installation ID, connection generation, kind, source fingerprint, reserved ID or verified content metadata, and expected folder.

## 15. Remote changes and local cleanup

Remote reconciliation runs at boot, periodically, after database restoration, and immediately before any retention deletion.

For a verified Drive object attempt:

- missing Drive ID plus a trusted local source: mark that attempt `missing`, retain its ID, and create a new attempt for the artifact;
- missing Drive ID without a trusted local source: mark that attempt `missing` and alert;
- changed parent, ownership, private/shared state, expected metadata, size, SHA-256 checksum, or binary `headRevisionId`: mark that attempt `detached`;
- content and `headRevisionId` still matching but manually renamed: preserve the file, keep using the exact ID, and update recorded presentation metadata plus the accepted file `version` only when every non-name field still matches, because names are presentation rather than ownership;
- an otherwise unexplained file `version` change: mark the attempt `detached`, even if currently visible metadata has returned to its old values;
- trashed file: mark that attempt missing but never empty Trash or permanently delete it from Trash; create a new attempt only when the local source is trusted; and
- provider access failure: preserve state and retry or require authorization according to the typed error.

A detached attempt is sticky. Automatic reconciliation does not overwrite, delete, re-parent, or silently re-adopt it. A new attempt does not erase or mutate the detached attempt. An administrator may inspect the status and resolve the Drive state manually; explicit future recovery tooling is outside this specification.

“Local is master” defines direction, not infinite local retention. Existing local video cleanup may remove an old local recording only after its artifact has a current Drive attempt that is:

- verified by exact ID, size, SHA-256 checksum, and binary `headRevisionId`;
- present in the expected managed folder;
- owned by the active account;
- not detached, missing, trashed, or under investigation; and
- outside any active upload or reconciliation operation.

Once a local copy is removed, the Drive file becomes a remote-only archive. Deleting that local copy never requests remote deletion. A detached Drive attempt can never justify local cleanup.

The old rclone behavior that treated unreferenced files as sweepable or assumed a successful directory copy is removed. Filesystem reconciliation registers valid completed Motion files; it does not delete them.

## 16. Error model and recovery

Infrastructure adapters map Google, network, filesystem, cryptographic, and Telegram failures to typed errors such as:

- `DriveAuthorizationPendingError`;
- `DriveAuthorizationDeniedError`;
- `DriveReauthorizationRequiredError`;
- `DrivePolicyBlockedError`;
- `DriveQuotaExceededError`;
- `DriveRateLimitedError`;
- `DriveTemporaryUnavailableError`;
- `DriveObjectMissingError`;
- `DriveObjectConflictError`;
- `DriveObjectDetachedError`;
- `DriveAttemptLeaseLostError`;
- `DriveFolderAmbiguousError`;
- `DriveClockUnhealthyError`;
- `DriveLocalSourceChangedError`;
- `DriveCredentialCorruptError`; and
- `DriveConfigurationError`.

Error behavior is determined by type:

- authorization pending continues at the instructed interval;
- rate limits and temporary failures retry with bounded backoff and jitter;
- quota failures enter the quota workflow without monopolizing the scheduler;
- invalid grant or policy failures require administrator action;
- local source changes restart candidate stabilization rather than uploading mutable bytes;
- lost leases stop the stale worker from writing and let the current lease owner continue recovery;
- ambiguous managed folders and unhealthy clocks fail mutation closed and require administrator action;
- remote conflicts and detachments preserve both sides and alert;
- malformed credentials fail before replacing the active connection; and
- programming or invariant failures are logged without secrets and leave durable state recoverable.

TLS failures that coincide with an implausible or unsynchronized system clock are reported as a system-clock problem, not as an OAuth credential failure. The worker does not weaken TLS validation.

## 17. Shutdown, scheduling, and Raspberry Pi limits

All Drive work supports cancellation through the existing graceful shutdown path. On `SIGINT` or `SIGTERM`:

1. stop accepting new scheduled Drive work;
2. cancel device polling and active HTTP requests;
3. abort an active upload instead of waiting for a full video transfer;
4. finish only short database state transitions;
5. leave the attempt lease recoverable and its encrypted resumable session durable; and
6. close the application normally.

PM2's default kill timeout is too short for reliable cancellation and durable state updates. The application configuration increases it to a bounded value sufficient for request abortion and SQLite writes, not for completing an arbitrary upload.

Runtime resource rules:

- Node.js 22 LTS on every supported Pi architecture;
- one active Drive transfer;
- streaming reads and bounded network buffers;
- no whole-video hashing buffer or in-memory backup;
- no unbounded Drive listings; always paginate;
- bounded filesystem reconciliation batches;
- bounded retry queues and alert state; and
- process memory remains below PM2's 512 MiB restart limit.

Node.js 22 is selected rather than Node.js 24 because the supported Raspberry Pi 3 population can include 32-bit ARMv7 installations, for which Node.js 22 still publishes official binaries while ARMv7 support is downgraded in Node.js 24. The implementation must verify `better-sqlite3` installation and backup behavior on each supported Raspberry Pi OS/architecture combination under Node.js 22 before release.

## 18. Telegram status and alerts

`/gdrive status` is private and admin-only. It reports:

- connection state and confirmed Google `permissionId`, plus email and display name when available;
- root, motion, and backup folder links;
- last successful authorization refresh, upload, backup, reconciliation, and cleanup;
- last sanitized failure;
- artifact counts and separate pending, retryable, verified, missing, detached, conflict, and abandoned attempt counts;
- retired or disconnected generations whose preserved remote files are no longer automatically manageable;
- Drive quota limit, total usage, Drive usage, and Drive Trash usage when Google provides them;
- the current quota-reclamation byte count and accounting-window state; and
- whether a reauthorization, clock correction, or manual Drive cleanup is required.

Private Drive links and account details are never included in group responses, notifications to non-admin users, logs, or general status commands.

Rate-limited alerts cover:

- reauthorization required;
- OAuth project or organization policy rejection;
- quota exhaustion and quota-reclamation progress;
- Drive object missing or detached;
- retired-generation archives that require manual Drive review;
- prolonged upload or backup-sync failure;
- encryption-key loss or credential corruption;
- implausible system clock; and
- local disk pressure while Drive cannot accept uploads.

Alert cooldowns are durable across restarts so a boot loop cannot flood Telegram.

## 19. Rclone removal

Because the system was never in production, no rclone migration or compatibility layer is built.

Implementation removes repository-owned rclone remnants, including:

- runtime adapters, use cases, schedulers, and path-based sync assumptions;
- dependencies and shell invocations;
- installer steps and validation checks;
- rclone configuration keys and environment documentation;
- obsolete tests and fixtures;
- legacy schema fields that store rclone remote paths; and
- docs that claim rclone is the active Drive transport.

Schema changes follow the normal Drizzle process: edit `schema.ts` and generate migrations with the repository command. Existing migration files are not hand-edited.

Removal does not:

- uninstall a system-wide rclone package;
- delete a user's rclone configuration;
- revoke rclone or Google credentials;
- delete an existing rclone remote directory;
- empty Google Drive Trash; or
- infer that any pre-existing Drive file is safe to remove.

## 20. Testing strategy

### 20.1 Unit and use-case tests

Motion candidate and recovery tests cover:

- valid completed event;
- incomplete, empty, unstable, symlinked, traversing, outside-root, and unexpected-format paths;
- duplicated hooks;
- several event rows referencing one file;
- lost hook recovered by periodic reconciliation;
- arbitrary unreferenced files outside the expected completed-Motion shape not registered;
- source mutation during hashing or upload;
- replacement content with the same path, size, and modification time but a different SHA-256 digest; and
- deduplication by the canonical content-bearing source fingerprint.

Upload and manifest tests cover:

- reserved-ID persistence before transfer;
- one artifact with several immutable historical attempt rows;
- old attempt IDs and metadata never overwritten by replacement attempts;
- clean success;
- timeout before response with successful remote creation;
- retry conflict on an already-created ID;
- wrong size, SHA-256 checksum, or binary `headRevisionId`;
- process restart and SIGKILL during transfer;
- expired attempt lease recovery;
- persisted-session status responses `200`, `201`, `308`, and `404`;
- server-confirmed offset taking precedence over the locally stored offset;
- expired session with same-ID reuse permitted and forbidden;
- missing remote with and without a local source;
- manual rename;
- move, sharing/ownership change, content replacement, and sticky detachment;
- restored-database reconciliation; and
- no duplicate upload after retries.

Retention tests cover:

- seven-day backup expiry using Drive `createdTime`;
- far-past and far-future Raspberry Pi clocks;
- missing, invalid, and implausible provider timestamps failing closed;
- videos preserved without quota pressure;
- cleanup order;
- 90-day remote-only protection;
- younger-video deletion only with a verified local copy;
- unrelated quota usage;
- insufficient eligible managed bytes;
- unavailable or inconsistent quota;
- delayed quota accounting and no cascading deletion;
- exact-ID pre-delete validation; and
- no Trash or query-based deletion.

Scheduler tests cover backup priority, older-retry fairness, one-transfer concurrency, 24-hour backup catch-up, timezone behavior, shutdown cancellation, durable retry state, and stale temporary backup cleanup. A deliberately stalled video transfer must not block SQLite snapshot creation, candidate registration, status, or cleanup of an unrelated local artifact.

### 20.2 OAuth and Telegram tests

OAuth adapter tests cover pending, approval, denial, expiration, `slow_down`, rate limiting, invalid client, admin policy, transient failures, token-field merge, automatic refresh, revision-fenced late token events, and one-way transition on `invalid_grant`.

Workflow tests cover:

- private admin requirement;
- group and non-admin rejection;
- declared and streaming JSON size enforcement plus shape validation;
- malicious endpoint fields ignored;
- discovery success plus unexpected origin, path, redirect, and unavailable-document failures;
- Telegram message deletion success and failure;
- stale callback and expired workflow;
- competing administrator;
- wrong-account rejection;
- account confirmation with and without email/display name;
- stable matching by Drive `permissionId`;
- restart during document receipt, polling, post-exchange confirmation, and folder creation;
- expiry cleanup of staged encrypted secrets;
- failed staged connection preserving the active generation;
- same-client/account reauthorization;
- different-client/account generation replacement and previous-secret removal;
- explicit disconnect, revocation success and failure, and remote-data preservation;
- boot recovery of interrupted `retiring` and `disconnecting` jobs; and
- retired-generation manual-cleanup status.

### 20.3 Infrastructure and safety tests

Infrastructure tests cover:

- AES-GCM round trip, tamper detection, missing key, and rejection of a valid envelope transplanted to another row or field;
- managed-folder reuse and creation;
- duplicate folder names;
- pre-generated folder IDs and ambiguous folder-creation outcomes;
- multiple valid managed-folder candidates failing closed;
- pagination, `incompleteSearch`, and rejected page-token restart;
- Drive error mapping;
- bounded HTTP timeouts and upload stall;
- graceful abort;
- no secrets in structured logs;
- no plaintext client JSON on disk and redaction of Telegram download and resumable-session URLs;
- admin-only Drive links;
- bounded memory behavior with a large synthetic stream; and
- no operation on unrelated or malformed Drive files;
- same-filesystem backup staging, `quick_check`, file/directory flush, and atomic rename; and
- local backup retention pinning until a verified Drive attempt exists.

### 20.4 Live smoke test

A disposable Google account and dedicated production-mode test project validate the real device flow:

1. authorize through Telegram;
2. confirm account and folder creation;
3. upload and verify one Motion fixture and one SQLite backup;
4. restart the process and verify refresh-token reuse;
5. kill the process mid-upload, restart, query the saved resumable session, and continue without duplicating the object;
6. simulate an ambiguous upload response and verify immutable attempt history;
7. move and replace a managed Drive file and verify detachment;
8. delete a remote file and verify safe local-based recreation as a new attempt;
9. exercise backup expiration, an implausible local clock, and a controlled quota failure;
10. replace the OAuth client and verify retired-generation warnings and local secret removal; and
11. verify no unrelated Drive or Trash item changes.

No production account is used for destructive smoke tests.

## 21. Completion criteria

The implementation is complete when:

- build, unit, integration, lint, and generated-migration checks pass;
- the application and installer consistently target Node.js 22 LTS;
- supported Raspberry Pi hardware passes the `better-sqlite3` and streaming-upload smoke checks;
- a third-party administrator can complete setup after downloading the OAuth JSON without SSH or manual configuration;
- access tokens refresh automatically across restarts using the retained refresh token;
- completed Motion videos missed by the hook are recovered through bounded reconciliation;
- database backups continue locally when Drive is unavailable;
- a stalled or crashed upload cannot block SQLite snapshot creation or unrelated local cleanup;
- a process restart resumes or safely reconciles an encrypted durable resumable session through an expired attempt lease;
- every replacement remote object creates a new immutable attempt row without overwriting an earlier Drive ID;
- Drive quota exhaustion cannot stall Motion, Telegram, local backups, or the scheduler;
- every permanent deletion is an exact, revalidated immutable attempt ID created by this installation;
- the worker never empties Trash or deletes an unrelated, detached, ambiguous, or sole young remote artifact;
- local cleanup never relies on an unverified or detached Drive copy;
- Google account matching uses `permissionId` and succeeds when email is absent;
- replacing or disconnecting a generation removes old OAuth secrets from live logical state and clearly reports preserved unmanaged remote archives;
- no runtime, installer, configuration, schema, test, or active documentation path depends on rclone;
- the application operates on a host without rclone installed; and
- logs, Telegram messages, and status output contain no OAuth secrets, device codes, bot-token-bearing download URLs, or resumable-session URLs.

## 22. External constraints and references

Implementation must re-check current official documentation before coding because Google authentication and Drive behavior can change. The design relies on these provider contracts:

- [Google OAuth 2.0 for TVs and limited-input devices](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
- [Google OAuth refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Drive file creation and upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive generated IDs](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds)
- [Google Drive file listing](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [Google Drive app properties](https://developers.google.com/workspace/drive/api/guides/properties)
- [Google Drive file metadata, checksums, revisions, ownership, and capabilities](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [Google Drive user identity fields](https://developers.google.com/workspace/drive/api/reference/rest/v3/User)
- [Google Drive permanent file deletion](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/delete)
- [Google Drive usage and quota fields](https://developers.google.com/workspace/drive/api/reference/rest/v3/about)
- [Google storage space not updating after deletion](https://support.google.com/drive/answer/6374270)
- [google-auth-library for Node.js](https://github.com/googleapis/google-auth-library-nodejs)
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [Node.js supported platforms and ARMv7 status](https://github.com/nodejs/node/blob/main/BUILDING.md#platform-list)

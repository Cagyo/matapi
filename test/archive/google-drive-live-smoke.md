# Google Drive live release smoke record

This is an operator-run release gate, not an automated test. Use a disposable
Google account containing clearly named unrelated files in My Drive and Trash.
Never run it against a personal or production account. The repository test run
does not prove this procedure passed.

## Release record

Complete one row for every Raspberry Pi OS/architecture combination that the
release owner chooses to support. The project does not claim an exhaustive
matrix until those rows are recorded.

| Date / operator | Pi model / RAM | Raspberry Pi OS release | Debian architecture | Kernel | Node (`node -v`, must be 22.x) | `better-sqlite3` install + native backup | Peak worker RSS (must stay <512 MiB) | Upload + resume | Drive safety | Result / evidence link |
|---|---|---|---|---|---|---|---|---|---|---|
| _not run_ | | | | | | | | | | |

For each row, attach sanitized command output, PM2 RSS samples, Telegram
screenshots, archive-manifest queries, and before/after Drive inventories. Do
not attach OAuth/client secrets, device codes, access/refresh tokens, bot-token
URLs, or resumable-session URIs.

## Preparation

1. Record hardware, RAM, OS image/release, `dpkg --print-architecture`, kernel,
   Node 22 version, commit, and package lock checksum.
2. Install on a fresh host that has no separate Drive synchronization utility
   and no prior Home Worker cloud configuration. Confirm install and boot do not
   add or inspect such user configuration.
3. Verify `/etc/home-worker` is `root:homeworker` `0750`; verify `archive.key`
   is a regular single-link 32-byte `root:homeworker` `0640` file. Re-run the
   installer and prove its digest is unchanged. Replace a test installation's
   path with a symlink and prove the installer fails without overwriting it.
4. Install/build `better-sqlite3` under Node 22. Create a native online backup,
   run SQLite `quick_check`, and record the result.
5. In the disposable Drive account, create `UNRELATED_KEEP` in My Drive and
   `UNRELATED_TRASH_KEEP` in Trash. Save IDs, parents, revisions, sizes, and
   Trash state for the final comparison.
6. Start PM2/RSS sampling at an interval that captures upload peaks.

## Authorization and normal archive flow

1. In a private administrator chat, run `/gdrive connect`, upload an installed-
   client JSON document, and prove the Telegram document is deleted or the
   manual-deletion warning appears.
2. Complete device authorization, then confirm the displayed account. Record
   permission identity even if email and display name are absent.
3. Prove the private root, Motion, and Backups folders are created once and are
   not shared.
4. Capture one stable Motion video and create one native database backup. Prove
   each has one current verified attempt with the expected parent, properties,
   size, digest, provider timestamps, revision, ownership, and sharing state.
5. Restart the worker. Prove OAuth refresh survives, status remains sanitized,
   and no duplicate folder or object appears.

## Upload interruption and ambiguity

1. Start a large streaming upload, confirm RSS remains below 512 MiB, then send
   `SIGKILL` mid-upload. Restart and prove the durable session resumes from the
   authoritative offset without a duplicate remote object.
2. At the HTTP test gateway, return an ambiguous final response after Drive has
   accepted the bytes. Prove reconciliation adopts only the immutable attempt's
   exact object and does not upload another copy.
3. Exercise saved-session 200, 201, 308, and 404 paths. Prove each reaches a
   deterministic verified/retryable outcome and never adopts an unrelated ID.
4. Stall a video transfer. During the stall, create a snapshot, register another
   completed candidate, run status, create/locate a backup, and run unrelated
   local cleanup. Record that these operations finish independently.
5. Disable or interrupt the Motion completion hook while a stable video closes,
   then restore the hook and restart the worker. Prove filesystem reconciliation
   registers the missed video exactly once, creates at most one immutable Drive
   attempt, and does not inspect or mutate either unrelated sentinel item.
6. Kill the worker after an upload attempt lease is acquired, wait beyond the
   recorded lease expiry, and restart. Prove boot recovery reclaims the expired
   lease and resumes or retries the same immutable attempt/remote ID without a
   duplicate object. Inventory both unrelated sentinel items before and after
   and record that neither was read for mutation, moved, deleted, or trashed.

## Remote mutation and generation safety

1. Move a verified object outside its managed folder. Reconcile and prove the
   attempt becomes detached and is preserved.
2. Replace a verified object under the same name. Prove the replacement creates
   a new attempt and preserves every earlier ID and metadata row.
3. Delete a verified remote object. Reconcile, then restore from the unchanged
   trusted source as a new attempt; prove the old missing attempt remains audit
   history.
4. Disconnect. Prove live OAuth secret references are cleared, remote objects
   remain, and the disconnected generation stays visible but unmanaged.
5. Reconnect and prove all mutations are fenced to the new active generation.

## Retention, clock, and quota

1. With controlled provider timestamps, expire an eight-day-old backup. Prove
   the worker reloads the active generation, artifact, attempt, and exact ID
   immediately before deletion. The seven-day boundary must remain.
2. Make the host clock unsynchronized, implausibly old, implausibly future, and
   excessively offset. Prove age-based deletion stops and status requests clock
   correction.
3. Exhaust quota in a controlled manner. Prove Motion, Telegram, local backups,
   and later scheduler cycles continue. Verify reclamation accounting prevents
   cascading deletion while Drive quota is stale.
4. Exercise generation replacement during retention admission. Prove the old
   generation's candidate is preserved.
5. Remove or corrupt the archive key on a disposable installation. Prove Drive
   becomes `reauth_required`, the key is not silently replaced, and Motion,
   Telegram, and local backup continue.

## Final safety comparison

1. Inventory managed folders, managed objects, My Drive, and Trash by ID.
2. Compare `UNRELATED_KEEP` and `UNRELATED_TRASH_KEEP` with the preparation
   record. Their IDs, parents, revisions, contents, and Trash state must be
   unchanged.
3. Prove no bulk delete/search path acted on detached, ambiguous, moved,
   replaced, shared, trashed, or unrelated objects.
4. Search sanitized logs and Telegram output for client secrets, device codes,
   access/refresh tokens, bot-token URLs, and resumable-session URIs. Record zero
   findings.
5. Record final peak RSS, backup result, upload/resume result, Drive safety
   result, deviations, and the release owner sign-off in the matrix row.

## Current repository status

No live Raspberry Pi or disposable Google account checks were performed by the
repository implementation task. Release remains contingent on completed,
operator-recorded rows above.

# Task 12 Report — Exact Drive Reconciliation and Archive Verification

## Status

Complete. Task 12 is implemented and wired into the Task 11 archive lifecycle without changing Task 11's upload boundary. Task 13 was not started.

## Implementation

- Added `ArchiveVerificationPort` and its implementation for fresh, exact-ID verification of the active archive generation.
- Added reconciliation of verified Drive objects with strict metadata checks for parent, private ownership/sharing, managed properties, size, SHA-256, MD5, created time, revision, version, delete capability, and stored private link.
- Kept presentation-only rename as the sole accepted remote mutation. Any other mismatch permanently detaches the attempt from automatic reconciliation.
- Added missing/trashed handling that reserves a replacement Drive ID before atomically marking the old attempt missing and creating the replacement attempt. A reservation failure therefore remains retryable.
- Added bounded restore discovery for unambiguous, private, managed objects only. Detached IDs are never re-adopted, and live reservations must match the candidate's exact ID.
- Added full streaming local SHA-256 verification with pre/post size and modification-time checks so a changing local source cannot be treated as verified.
- Added repository CAS operations for accepted renames and atomic verified-object adoption in both Drizzle and in-memory adapters.
- Registered reconciliation as a Task 11 remote lifecycle hook. Drive reads, listings, and local hashing remain outside the remote-state lock; only immediate state transitions use the lock.
- Reworked camera cleanup to require fresh `cleanupSafe` verification for the active generation. Removed the legacy orphan sweep and all Drive deletion behavior.
- Reworked motion-video delivery and browse hydration to use the verified current private `webViewLink`; stale stored Drive IDs are not trusted.
- Preserved remote-only private-link fallback when the exact remote object is valid but the local file is absent or changed. The Telegram boundary still checks administrator authorization before returning it.
- Updated the port catalogue for the new verification boundary.

## Safety Properties Verified

- Remote verification always loads the exact immutable Drive object ID.
- Missing or trashed objects never cause Drive deletion and never overwrite immutable attempt history.
- Remote drift other than a name-only presentation change is sticky detachment.
- Retired generations fail closed before a remote read.
- Local cleanup requires an exact active-generation remote match and an unchanged local source digest.
- Restore discovery is bounded and accepts exactly one fully managed match; ambiguity fails closed.
- No cleanup path performs a Drive delete or a broad remote sweep.

## TDD Evidence

RED was observed before implementation:

- Archive reconciliation and verification tests failed because the use cases and port did not exist.
- Camera cleanup and link-fallback tests failed because cleanup still used legacy heuristics/sweeps and delivery did not use archive verification.
- A dedicated replacement-reservation regression test failed while the old attempt was marked missing before ID reservation; implementation was then changed to reserve first.

GREEN verification:

- Focused Task 12 suite: `14` test files, `90` tests passed.
- Broader archive/Task 11/camera/Telegram suite: `29` test files, `206` tests passed.
- Integration-focused suite: `18` test files, `119` tests passed.
- `yarn build`: passed.
- Task 12 ESLint paths: passed.
- `git diff --check`: passed (Git emitted the repository's existing fsmonitor IPC warning only).

## Worktree Hygiene

The worktree contained unrelated edits and an unrelated pre-existing deletion. They were preserved and excluded from the Task 12 commit by staging explicit paths only.

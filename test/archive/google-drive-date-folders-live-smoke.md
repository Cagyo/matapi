# Google Drive date-folders live smoke record

Run this checklist only on a supported Raspberry Pi with a disposable Google
Drive account. Use the exact release commit and normal non-root worker service.
This is an operator procedure, not an automated test, and it must not perform
any action against a personal or production Drive account.

## Privacy rules

Record only the aggregate evidence fields and pass/fail results requested below.
Never copy or photograph a local absolute path, filename, Drive folder/object
ID, installation/generation/artifact/attempt ID, OAuth client content, token,
device code, provider response body, or resumable session URI. Redact terminal
output before attaching it. The test account and every test object must be
disposable.

## Environment record

- Raspberry Pi model:
- Raspbian release:
- Node version:
- Commit SHA:
- Disposable Drive account type (consumer or Workspace only; no address):
- Smoke start timestamp with timezone:
- Smoke end timestamp with timezone:
- Observed maximum concurrent upload count:

## Procedure and evidence

For every numbered check, record `PASS` or `FAIL`, the start/end timestamps, and
a sanitized observation. Do not record identifying values prohibited above.

1. Disable networking. Across two different local calendar dates, record at
   least three completed Motion videos whose formats collectively use supported
   AVI, MKV, or MP4 extensions. Confirm Motion registration remains responsive
   while offline.
2. Restore networking. Record the timestamp when durable registration completes
   and the start timestamp of each consecutive transfer. Confirm the next
   eligible transfer begins after settlement without waiting for the two-minute
   safety interval; no consecutive-transfer gap may be two minutes or longer.
3. In the disposable Drive UI, inspect the exact shape
   `Home Worker Archive/Motion/YYYY/MM/DD/filename` for both local dates. Confirm
   every tested video is under its matching date and `Backups` objects remain
   direct children of `Home Worker Archive/Backups`.
4. During a resumable upload, restart the worker once. Record only whether the
   upload resumed from the provider-confirmed offset or safely replaced the
   unusable session/reservation; confirm it did not replay an unconfirmed range
   or create two current objects.
5. Select one old flat Motion object whose exact matching local source is still
   present and unchanged. Remove only that exact disposable Drive object. Run
   reconciliation and confirm only that object is recreated beneath its exact
   date folder; unrelated flat or nested objects must remain unchanged.
6. Throughout the drain, verify Motion keeps recording, Telegram responds,
   `/gdrive status` returns aggregate sanitized state, database backup creation
   completes, reconciliation runs, and local cleanup remains responsive.
7. Confirm the observed maximum concurrent upload count is exactly one. Review
   every captured note/screenshot/log for prohibited IDs, paths, filenames,
   credentials, tokens, provider bodies, and session URIs before retaining the
   smoke record.

## Result

- Overall: `PASS` / `FAIL`
- Failed check numbers (if any):
- Sanitized follow-up reference (optional; no sensitive data):

# Google Drive date-folders live smoke record

Execution status: **NOT RUN**. This is required manual release evidence; CI is
not a substitute.

Run this procedure only on a supported Raspberry Pi with a disposable Google
Drive account, the exact release commit, and the normal non-root worker service.
Never run it against a personal or production account.

## Privacy rules

Record only timestamps, pass/fail results, and sanitized aggregate observations.
Never copy or photograph a Drive ID, local path, filename, installation,
generation, artifact or attempt ID, OAuth content, token, device code, chat ID,
provider response body, or resumable URI. Redact terminal output before
attaching it. The account and every remote object used here must be disposable.

## Environment record

- Raspberry Pi model:
- Raspbian release:
- Node 22 exact version:
- Exact commit SHA:
- Generated migration 0022 applied (`YES` / `NO`):
- Generated migration 0023 applied (`YES` / `NO`):
- Disposable account type (`consumer` / `Workspace`; no address):
- Overall smoke start timestamp with timezone:
- Overall smoke end timestamp with timezone:

Both generated migrations are required: 0022 adds continuous-sync feature
state and indexes; 0023 rebuilds the affected tables with the required
constraints. Do not begin unless both report `YES`.

## Nine-step procedure and evidence

For every step, fill in all four evidence fields. Observations must remain
aggregate and must not contain any value prohibited above.

### 1. Record while offline

Disable networking and record several completed Motion videos across two local
calendar dates. Confirm Motion remains responsive and completed-video recovery
does not require Drive connectivity.

- Start timestamp with timezone:
- End timestamp with timezone:
- Result (`PASS` / `FAIL`):
- Sanitized aggregate observation:

### 2. Restore connectivity and register

Restore networking and confirm every eligible local video completes durable
Archive registration.

- Start timestamp with timezone:
- End timestamp with timezone:
- Result (`PASS` / `FAIL`):
- Sanitized aggregate observation:

### 3. Confirm continuous draining

Observe consecutive transfer settlements and admissions. Confirm the next
eligible item starts without a two-minute inter-file pause and that no more than
one upload is active at once.

- Start timestamp with timezone:
- End timestamp with timezone:
- Result (`PASS` / `FAIL`):
- Sanitized aggregate observation:

### 4. Confirm the exact remote hierarchy

In the disposable account, confirm tested videos appear only under
`Home Worker Archive/Motion/YYYY/MM/DD/filename` for their matching dates and
that backup objects remain direct children of `Home Worker Archive/Backups`.

- Start timestamp with timezone:
- End timestamp with timezone:
- Result (`PASS` / `FAIL`):
- Sanitized aggregate observation:

### 5. Restart during a resumable upload

Restart the worker during one resumable transfer. Confirm it continues from the
provider-confirmed offset or safely replaces an unusable session/reservation,
without replaying an unconfirmed range or creating two current objects.

- Start timestamp with timezone:
- End timestamp with timezone:
- Result (`PASS` / `FAIL`):
- Sanitized aggregate observation:

### 6. Rename a date folder during upload

Rename one disposable date folder while a video targeting that branch is in
flight. Confirm the attempt does not become verified, local retention stays
blocked, the exact hierarchy is restored, and exactly one bounded recovery
probe runs.

- Start timestamp with timezone:
- End timestamp with timezone:
- Result (`PASS` / `FAIL`):
- Sanitized aggregate observation:

### 7. Remove one duplicate date-folder candidate

Create a disposable duplicate candidate, allow the branch to become blocked,
then remove one candidate. Confirm one survivor is adopted and no parallel
folder is created.

- Start timestamp with timezone:
- End timestamp with timezone:
- Result (`PASS` / `FAIL`):
- Sanitized aggregate observation:

### 8. Replace one flat video while its local source exists

With the unchanged local source still present, remove one legacy flat remote
video and run reconciliation. Confirm one nested replacement appears and
unrelated objects remain unchanged. Record this limitation: a remote-only flat
video cannot be recreated after its local source is pruned.

- Start timestamp with timezone:
- End timestamp with timezone:
- Result (`PASS` / `FAIL`):
- Sanitized aggregate observation:

### 9. Confirm service responsiveness throughout

Confirm database backups, Motion recording, Telegram, aggregate Drive status,
reconciliation, and local cleanup remain responsive during all preceding
pressure and recovery steps.

- Start timestamp with timezone:
- End timestamp with timezone:
- Result (`PASS` / `FAIL`):
- Sanitized aggregate observation:

## Result

- Overall result (`PASS` / `FAIL` / `NOT RUN`): `NOT RUN`
- Failed step numbers, if any:
- Sanitized follow-up reference, if any:

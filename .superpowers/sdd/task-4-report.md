Task 4 report

Changed `scripts/rollback.sh` so the default database path now points to `data/worker.db` instead of `data/dev.db`.

Verification:
- `bash -n scripts/rollback.sh && grep -c 'data/worker.db' scripts/rollback.sh`
- Result: syntax OK, count `1`

Commit:
- `8f64b56` `fix(scripts): rollback writes system_meta to worker.db by default`

Notes:
- Only `scripts/rollback.sh` was committed.

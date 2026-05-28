# 21 — Google Drive Sync

## Dependencies
- 01-database.md (motion_events table)
- 20-camera.md (file structure, motion events)
- 00-overview.md (.env rclone/gdrive settings)

## Overview

rclone uploads motion files to Google Drive. Cleanup runs on both local and Drive sides based on configurable thresholds.

## Auth

Google Drive service account (no OAuth token expiry). Service account key stored in rclone config, not in `.env`.

## Upload Flow

```
Motion event ends
       │
       ▼
Worker logs event in motion_events (uploaded_to_gdrive = false)
       │
       ▼
UploadService queues upload job
       │
       ▼
rclone copy (per-file, ionice -c3)
       │
       ├─ Success → uploaded_to_gdrive = true, store gdrive_file_id
       └─ Failure → retry on next cycle
```

### rclone Command

```bash
ionice -c3 rclone copy /var/lib/motion/ gdrive:home-security/motion/ \
  --min-age 1m \
  --transfers 2 \
  --bwlimit 1M
```

- `ionice -c3`: lowest I/O priority, prevents SQLite busy timeouts
- `--min-age 1m`: don't upload files still being written
- `--transfers 2`: limit parallel uploads
- `--bwlimit 1M`: Pi-friendly bandwidth limit

All values configurable via `RCLONE_TRANSFERS` and `RCLONE_BW_LIMIT`.

## Upload uses `rclone copy`, NOT `rclone sync`

`rclone copy` is one-way additive. It uploads new files without deleting anything on Drive. `rclone sync` would mirror local deletions to Drive — the **opposite** of what we want. Local cleanup should not trigger Drive deletion.

## Failure Handling

- Individual file failure: mark as not uploaded, retry next cycle
- After 5 consecutive failures: notify admin "⚠️ Google Drive sync failing: [error]"
- Failure counter reset on first successful upload
- `/gdrive status` shows error state and failure count

## Local Cleanup

CleanupService runs hourly:

```
Check disk usage (df)
       │
       ├─ < 80% → do nothing
       │
       ├─ ≥ 80% (DISK_CRITICAL_PERCENT):
       │   ├─ Find oldest files WHERE uploaded_to_gdrive = true
       │   ├─ Delete local files
       │   ├─ Delete empty day-directories (YYYY/MM/DD)
       │   └─ Update motion_events: local_deleted = true
       │
       └─ ≥ 95% (DISK_EMERGENCY_PERCENT):
           ├─ All above, plus:
           ├─ Prune sent events older than 1 day
           ├─ Prune sensor_logs older than 1 day
           ├─ Stop motion daemon
           └─ Notify admin: "🚨 Emergency disk cleanup"
```

**Critical rule:** NEVER delete a file that hasn't been uploaded. If Drive sync is broken and disk fills up, alert admin instead of losing footage.

## Google Drive Cleanup

Runs when Drive quota exceeds 80% (`GDRIVE_CLEANUP_PERCENT`):

```
Check Drive quota (rclone about)
       │
       ├─ < 80% → do nothing
       │
       └─ ≥ 80%:
           ├─ Find oldest files on Drive (minimum 30 days retention)
           ├─ Delete from Drive
           └─ Update motion_events: gdrive_file_id = null
```

- Minimum retention: 30 days (`GDRIVE_CLEANUP_MIN_AGE_DAYS`)
- Free Google Drive: 15GB (~3 months at moderate motion frequency)

## Database Backup Upload

Separate from motion sync. Daily backup uploaded to `gdrive:home-security/backups/`:

```bash
ionice -c3 rclone copy /opt/home-worker/data/backup.db \
  gdrive:home-security/backups/worker-$(date +%Y-%m-%d).db
```

- Keep last 7 backups on Drive
- Delete older via `rclone delete --min-age 7d`

## Health Monitoring

`/gdrive status` reports:
- Drive quota (used / total / percentage)
- Last successful upload timestamp
- Pending upload count
- Failed upload count + last error
- Auto-cleanup status

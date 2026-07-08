# 20 — Camera Module

## Dependencies
- 01-database.md (cameras table, motion_events table)
- 00-overview.md (.env, MOTION_LOCAL_DIR)

## Overview

Motion daemon captures video on movement detection. Worker receives events via HTTP hooks, logs them, and provides snapshot/video access via bot commands.

## Motion Daemon Setup

Systemd service, independent of worker:

```bash
# /etc/sudoers.d/homeworker-motion
homeworker ALL=(ALL) NOPASSWD: /usr/bin/systemctl start motion, /usr/bin/systemctl stop motion, /usr/bin/systemctl restart motion
homeworker ALL=(ALL) NOPASSWD: /bin/systemctl start motion, /bin/systemctl stop motion, /bin/systemctl restart motion
```

## Motion Config Hooks

```
# motion.conf — URLs must be quoted: Motion runs hooks via `sh -c`,
# and an unquoted `&` backgrounds curl and silently drops `file=%f`.
on_event_start curl -s "http://localhost:4000/motion/event-start?camera=%t"
on_event_end curl -s "http://localhost:4000/motion/event-end?camera=%t&file=%f"
on_picture_save curl -s "http://localhost:4000/motion/snapshot?file=%f"
```

Worker exposes internal HTTP endpoints (not public) for these hooks.

## File Structure

```
/home/pi/motion/videos/
├── 2026/
│   ├── 03/
│   │   └── 08/
│   │       ├── 125106.mp4
│   │       ├── 125106.jpg
│   │       ├── 130042.mp4
│   │       └── 130042.jpg
│   └── 04/
│       └── 08/
│           └── ...
```

Path format: `YYYY/MM/DD/HHMMSS.{mp4,jpg}`

Videos cut into 30-second segments (`MOTION_VIDEO_SEGMENT_SEC`).

## Internal HTTP Endpoints

### POST /motion/event-start
- Create `motion_events` row with `startedAt`, `cameraId`
- Trigger notification to users (with snapshot if available)

### POST /motion/event-end
- Update `motion_events` row with `endedAt`, `videoPath`
- Queue file for Google Drive upload

### POST /motion/snapshot
- Update `motion_events` row with `snapshotPath`

## Snapshot Port (application/infrastructure)

Snapshot fetching is a port — `SnapshotPort` in `camera/domain/ports/` — with one production adapter (`FfmpegSnapshotAdapter` in `camera/infrastructure/`). The handler for `/camera snapshot` depends on `SnapshotPort`, not on ffmpeg or any buffer cache.

```typescript
// src/camera/application/get-snapshot.use-case.ts
@Injectable()
export class GetSnapshotUseCase {
  constructor(
    @Inject(SNAPSHOT) private readonly snapshot: SnapshotPort,
    @Inject(CLOCK)    private readonly clock: ClockPort,
  ) {}

  execute(cameraId: string): Promise<Buffer> {
    return this.snapshot.grab(cameraId);    // caching lives inside the adapter
  }
}
```

The adapter implements the 2-second cache (`MOTION_SNAPSHOT_CACHE_TTL_MS`) and the actual `ffmpeg -i <source> -frames:v 1 -f image2pipe pipe:1` invocation. The TTL prevents concurrent ffmpeg spawns. Add `SnapshotPort` to [../ports-and-adapters.md → Camera context](../ports-and-adapters.md#camera-context) when implementing.

## Multiple Cameras

Schema supports multiple cameras from day one. Commands default to first camera if name omitted.

## Motion Daemon Lifecycle

Worker monitors motion daemon health:
- Periodic `systemctl is-active motion` check
- On crash: attempt restart (up to 3 times with backoff)
- Persistent failure: notify admin, mark feature as degraded

## Video Delivery

Telegram file limit: 50MB.
- 30s clips at 640x480 (8 fps): typically under 50MB
- If over 50MB: compress with ffmpeg (lower bitrate)
- If still over: send Google Drive link instead

## Error Handling

| Scenario | Response |
|----------|----------|
| Motion daemon not running | Related commands return error, admin notified |
| Motion daemon crashes | Auto-restart up to 3 times, then alert |
| ffmpeg snapshot fails | Return error to command, log |
| Hook endpoint receives bad data | Log warning, ignore |
| Truncated video (power loss) | Detected on boot, marked in DB |

## Timezone

Motion daemon must have timezone explicitly configured in `motion.conf` to match `TIMEZONE` env var. Otherwise filenames won't match event timestamps in DB.

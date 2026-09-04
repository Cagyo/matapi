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
/home/pi/motion/
├── videos/
│   └── 2026/
│       ├── 03/
│       │   └── 08/
│       │       ├── 133439-1234567890.mkv
│       │       └── 133501-1234567891.mkv
│       └── 04/
│           └── 08/
│               └── ...
└── thumbnails/
    └── 2026/
        ├── 03/
        │   └── 08/
        │       ├── 133439-1234567890.jpg
        │       └── 133501-1234567891.jpg
        └── 04/
            └── 08/
                └── ...
```

Video path format: `/home/pi/motion/videos/YYYY/MM/DD/HHMMSS-<motion-event-id>.<movie extension>`
Thumbnail path format: `/home/pi/motion/thumbnails/YYYY/MM/DD/HHMMSS-<motion-event-id>.jpg`

Videos cut into 30-second segments (`MOTION_VIDEO_SEGMENT_SEC`).

## Internal HTTP Endpoints

### POST /motion/event-start
- Create `motion_events` row with `startedAt`, `cameraId`
- Trigger notification to users (with snapshot if available)

### POST /motion/event-end
- Update `motion_events` row with `endedAt`, `videoPath`
- Attempt immediate bounded registration, then wake the cooperative recovery
  traversal even when the file is not stable yet. Camera publishes only the
  provider-neutral Archive registration/runtime-signal ports.

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

## Completed-video recovery traversal

Boot, Motion completion, and the two-minute safety trigger wake one cooperative
filesystem traversal. The traversal carries an explicit, copied directory
cursor, hashes sequentially, and yields to the event loop before its immediate
continuation. Its four independently enforced per-run budgets are:

| Environment variable | Bounds | Default |
|---|---:|---:|
| `ARCHIVE_MOTION_RECOVERY_ENTRY_LIMIT` | 1–256 entries | 64 |
| `ARCHIVE_MOTION_RECOVERY_HASH_BYTES` | 65,536–67,108,864 bytes | 8,388,608 |
| `ARCHIVE_MOTION_RECOVERY_WALL_TIME_MS` | 10–1,000 ms | 100 |
| `ARCHIVE_MOTION_RECOVERY_DESCRIPTOR_LIMIT` | 1–64 descriptors | 16 |

A second wake coalesces behind the active traversal and never starts an
overlapping scan. `FsCompletedMotionVideoAdapter` keeps its `opendir` cursor and
streaming-hash continuation process-local. Cancellation or restart closes and
discards that state, so the next traversal starts from a fresh exact-root,
no-follow validation boundary; durable registration lookup makes replay
idempotent rather than treating the cursor as durable authority.

Only a fully completed traversal reports `motionTraversalCompleted(completedAtMs)`
through `ARCHIVE_RUNTIME_SIGNAL`. Archive records that timestamp with a
monotonic scheduler CAS and immediately wakes its drain pump. Camera never
imports an Archive repository or Google adapter.

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

## Telegram camera workflow UI

Camera replies that can continue or terminate a workflow carry localized inline
reply markup and an own-row Return Home button. Camera Return Home uses only
`rh:a:<c|r|t>`: callback data remains six UTF-8 bytes and excludes RTSP URLs,
credentials, tunnel URLs/tokens, paths, and Drive IDs.

- The browse UI emits and handles event action, video, photo, and Back-to-results
  callbacks. Its user-local result navigation cache expires after 10 minutes;
  expiry clears the cache and produces terminal recovery markup.
- Browse input/results and source-management UI state are mutually exclusive.
  Source state is keyed by the exact `(userId, chatId)` private-chat pair.
  Credentials are deleted from Telegram when possible and are never included in
  source labels, replies, markup, or Return Home data.
- Media replies retain their browse navigation markup. Root snapshot, event,
  video, photo, status, and motion-control replies clear competing camera UI
  state before producing terminal Home markup.
- Live opening and its active watch message use `leaveRunning` markup. Opening
  Home never stops or revokes a live stream. A stop, inactive-stream, or
  compensated live-open error is terminal. If `registerMessageReference` throws,
  the just-sent exact `(chatId, messageId)` watch message is not registered yet,
  so compensation deletes it before viewer revocation or its stop fallback.
  The live-session service separately deletes normal registered watch-message
  references on stop or expiry.

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

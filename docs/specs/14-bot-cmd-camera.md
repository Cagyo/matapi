# 14 — /camera Commands

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (cameras table, motion_events table)
- 20-camera.md (MotionService, SnapshotService)

---

## /camera snapshot [camera_name]

### Access
All users

### Syntax
```
/camera snapshot
/camera snapshot front_door
```

### Behavior
1. Reply with typing indicator: `ctx.replyWithChatAction('upload_photo')`
2. Get snapshot from SnapshotService (cached if < 2s old)
3. Send photo

### Output
Photo with caption:
```
📸 front_door | 08.04.2026 14:35
```

### Error Cases
| Condition | Response |
|-----------|----------|
| Camera not found | "❌ Camera 'xyz' not found" |
| Motion daemon not running | "❌ Motion daemon is not running. Admin: /camera enable" |
| ffmpeg snapshot fails | "❌ Failed to capture snapshot" |
| No cameras configured | "❌ No cameras configured" |

---

## /camera events [date]

### Access
All users

### Syntax
```
/camera events
/camera events 08.04.2026
```

### Behavior
1. Query `motion_events` for today (default) or specified date
2. List events with timestamps

### Output
```
📹 Motion events for 08.04.2026:

#42 — 12:51:06 (30s) 📷
#43 — 13:00:42 (30s) 📷
#44 — 15:22:18 (30s) 📷

3 events. Use /camera video <id> or /camera photo <id>
```

- 📷 icon indicates snapshot available
- Duration shown from `startedAt`/`endedAt`

### Error Cases
| Condition | Response |
|-----------|----------|
| Invalid date format | "❌ Use format: DD.MM.YYYY" |
| No events on date | "No motion events on 08.04.2026" |

---

## /camera video <event_id>

### Access
All users

### Syntax
```
/camera video 42
```

### Behavior
1. Reply with typing indicator: `ctx.replyWithChatAction('upload_video')`
2. Look up event in `motion_events`
3. Check if local file exists
4. If > 50MB: compress with ffmpeg, if still > 50MB: send Drive link
5. Send video

### Output
Video with caption:
```
📹 Event #42 | 08.04.2026 12:51:06 | front_door
```

### Error Cases
| Condition | Response |
|-----------|----------|
| Event not found | "❌ Event #42 not found" |
| Local file deleted, not on Drive | "❌ Video file no longer available" |
| Local file deleted, on Drive | Send Google Drive link |
| Compression fails | "❌ Failed to process video" |

---

## /camera photo <event_id>

### Access
All users

### Syntax
```
/camera photo 42
```

### Behavior
1. Look up event in `motion_events`
2. Send `snapshotPath` as photo

### Output
Photo with caption:
```
📸 Event #42 | 08.04.2026 12:51:06 | front_door
```

### Error Cases
| Condition | Response |
|-----------|----------|
| Event not found | "❌ Event #42 not found" |
| No snapshot for event | "❌ No snapshot available for event #42" |
| File not found | "❌ Snapshot file no longer available" |

---

## /camera enable

### Access
Admin only

### Syntax
```
/camera enable
```

### Behavior
Handler calls `EnableMotionUseCase`, which delegates to `MotionControlPort.start()`. The systemctl invocation lives in the adapter (`MotionDaemonAdapter` in `camera/infrastructure/`) — handlers never shell out directly (see ../ports-and-adapters.md → Camera context).

### Output
```
✅ Motion daemon started.
```

### Error Cases
| Condition | Domain error | Reply (from `en.ts`) |
|-----------|--------------|----------------------|
| Already running | `MotionAlreadyRunningError` | "ℹ️ Motion daemon is already running" |
| Start fails | `MotionStartFailedError` | "❌ Failed to start motion daemon: [error]" |
| Motion not installed | `MotionNotInstalledError` | "❌ Motion is not installed. Re-run install with motion feature." |

---

## /camera disable

### Access
Admin only

### Syntax
```
/camera disable
```

### Behavior
Handler calls `DisableMotionUseCase` → `MotionControlPort.stop()`. Same boundary rule as `/camera enable`.

### Output
```
✅ Motion daemon stopped.
```

---

## /camera status

### Access
All users

### Syntax
```
/camera status
```

### Behavior
Check motion daemon status, disk usage, last event.

### Output
```
📹 Camera Status

Motion: ✅ Running
Last event: 08.04.2026 15:22
Local storage: 847 MB
Events today: 12
```

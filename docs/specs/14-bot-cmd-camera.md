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

---

## Contextual camera workflow navigation

Every interactive camera reply, including dashboard, browse, media, live, and
source-management output, carries receipt-bound navigation controls. The only
workflow-return callback grammar is compact and secret-free `wr:<id>:[oh]`;
it never contains a source URL, token, filesystem path, or Drive identifier.

- Browse actions use `cam:<receipt-id>:...`: `be:<event-id>` selects an
  event, `bv:<event-id>` and `bp:<event-id>` request its video or photo, and
  `br` returns to the cached results. Result navigation is a per-user,
  receipt-bound in-memory cache with a 10-minute expiry. Missing or expired
  cache is cleared before the terminal recovery reply.
- Browse input/result state and source-management state are mutually exclusive.
  A browse callback clears the exact source state for the same user/private chat;
  a source callback clears browse input and results. Root camera actions clear
  both competing interface states before execution.
- Source-management callbacks use `cam:<receipt-id>:src:<action>` and state is
  keyed exactly by `(userId, chatId, receiptId)`. Credential text is deleted
  where possible and is never echoed in reply markup, output, or workflow-return
  callback data.
- Live opening marks its receipt `running`. Choosing Home deletes neither the
  watch message nor the stream session and never revokes/stops the stream.
  Stop, no-active, and compensated-error outcomes use terminal markup;
  if `registerMessageReference` throws, the just-sent exact
  `(chatId, messageId)` watch message has not yet been registered and is deleted
  before revoking the viewer or stopping the shared stream when revocation
  fails. Separately, the live-session service performs normal registered
  watch-message cleanup on stream stop or expiry.

Camera's natural direct-command parent is Home. Cancellable browse/source
drafts are cancelled only when their receipt ID matches; stale callbacks and
text never inspect or mutate a newer workflow. A completed live result after a
user has returned is delivered without replacing that newer Home.

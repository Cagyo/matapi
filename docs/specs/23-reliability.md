# 23 — Reliability

## Dependencies
- 01-database.md (system_meta table, events table, sensor_logs table)
- 06-bot-core.md (bot instance)
- 22-network.md (NetworkService)

## Graceful Shutdown

Shutdown sequence is **explicit and ordered**. NestJS `onModuleDestroy` hooks alone are not sufficient — order must be controlled:

```
1. Set shuttingDown = true (all modules check this flag)
2. Stop sensor event callbacks (SensorRegistry)
3. Wait for in-flight event processing (max 5s timeout)
4. Flush pending DB writes (CO2 memory buffer, batched ops)
5. Send "system going offline" to Telegram (await delivery)
6. Close bot polling connection
7. Close SQLite database
8. Delete PID lockfile
```

Bootstrap deliberately owns `SIGINT` and `SIGTERM` and does **not** call
`enableShutdownHooks()`, so there is only one process-signal handler. That
handler memoizes one shutdown operation, runs the ordered pre-close coordinator,
then calls `app.close()` exactly once. `app.close()` triggers Nest teardown
(`onModuleDestroy`, `beforeApplicationShutdown`, and `onApplicationShutdown`)
after the coordinator completes.

Within the sensors module, `SensorResourcesLifecycleAdapter` is the sole Nest
teardown owner for sensor resources: it first shuts down every active sensor
driver, then closes the shared pigpio gateway and MQTT connection pool. Driver
or shared-close failures are isolated so they cannot prevent the remaining
resources from being released. Before driver shutdown begins it places the MQTT
pool in lifecycle mode, so a final adapter `release()` cannot physically end a
client ahead of `destroyAll()`.

Each driver receives a `SensorDriverShutdownContext` containing an
`AbortSignal` and an absolute deadline. A driver must first become inert
(unsubscribe listeners, clear timers, and disable callbacks), then use the
context to bound its own pending transport cleanup. The registry awaits each
driver's completion; it never advances to shared gateways through a generic
outer timeout. This preserves the strict `drivers → shared resources` order
while preventing compliant GPIO, UART, camera, and MQTT adapters from stalling
teardown indefinitely.

### MQTT Recovery Ownership

MQTT.js performs reconnects with the sensor's validated 1,000–300,000 ms
`reconnectMs` period (default 5,000 ms). Its automatic resubscribe behavior is
disabled so each MQTT sensor adapter owns exactly one subscribe-and-SUBACK check
per successful `connect` event. The pool never adds a second application retry
timer or calls `client.reconnect()`.

Pooled clients are safe only when all sensors using a broker URL resolve to the
same reconnect and authentication options. A conflicting acquisition fails with
a non-secret configuration error rather than silently using first-writer values.

For broker availability, MQTT adapters start one shared-per-adapter outage timer
on either MQTT.js `offline` or `close`. A continuous outage beyond
`MQTT_OFFLINE_ALERT_MS` (60 seconds by default) emits one sensor error event.
The first subsequent `connect` emits one recovery event only when the outage was
previously signaled, then resubscribes the adapter. Transient outages are silent.
Adapter teardown clears this timer and removes the `message`, `connect`,
`offline`, and `close` handlers before releasing the pooled client.

### /restart Handling

Before shutdown step 1, store `restart_reason: 'user_command'` in `system_meta`. On boot, check flag → send "✅ Restart complete" → clear flag. Distinguishes user restart from crash.

## Boot Recovery

Startup sequence:

```
1. Write PID to /tmp/home-worker.lock
   - If lockfile exists and PID alive → refuse to start, log error
2. PRAGMA integrity_check on SQLite
   - If corrupt → recover from backup.db → notify admin
   - If no backup → create fresh DB → notify admin
3. Check system_meta for restart_reason
   - 'user_command' → send "Restart complete", clear flag
   - absent → normal boot or crash recovery
4. Detect truncated motion videos (power loss during recording)
   - Mark as corrupted in motion_events
5. Send "system online" notification with full sensor status
6. Start all sensor drivers
7. Drain unsent event queue
```

## Duplicate Instance Prevention

```typescript
// On startup
const LOCKFILE = '/tmp/home-worker.lock';

function acquireLock() {
  if (fs.existsSync(LOCKFILE)) {
    const pid = parseInt(fs.readFileSync(LOCKFILE, 'utf-8'));
    try {
      process.kill(pid, 0); // Check if process exists
      console.error(`Worker already running (PID ${pid}). Exiting.`);
      process.exit(1);
    } catch {
      // Process doesn't exist, stale lockfile
    }
  }
  fs.writeFileSync(LOCKFILE, process.pid.toString());
}

// On graceful shutdown
function releaseLock() {
  try { fs.unlinkSync(LOCKFILE); } catch {}
}
```

Additional protection: PM2 `instances: 1` in ecosystem.config.js.

## Error Handling Summary

### pigpiod Unavailable
- Startup: start bot without sensors, notify admin
- Mid-runtime: mark sensor offline, notify admin
- `/status`: shows `⚠️ OFFLINE (driver error)`

### Telegram API Unreachable
- Events queue in SQLite (sent_at = NULL)
- NetworkService detects, stops retry spam
- On reconnect: drain with aggregated summary
- grammY auto-retry handles 429/5xx

### rclone / Google Drive Failure
- Per-file retry on next cycle
- 5 consecutive failures → notify admin
- Files never deleted locally if not uploaded

### SQLite Corruption
- `PRAGMA integrity_check` on boot
- Recover from local backup if available
- If no backup: fresh DB, notify admin to /import_config

### Disk Full
| Threshold | Action |
|-----------|--------|
| 70% | Warn admin |
| 80% | Delete uploaded motion files aggressively |
| 95% | Emergency: prune logs/events, stop motion, alert |

Worker catches ENOSPC on every write, degrades gracefully.

### Motion Daemon Crash
- Detect via systemctl
- Restart up to 3 times with backoff
- Persistent failure: notify admin, mark degraded

### Bot Command Failure
- Catch at handler level
- Reply: "❌ Failed to [action]: [reason]"
- Log stack trace to PM2 logs
- Never crash process

### OTA Update Failure
- yarn install fails: auto-rollback, notify
- Migration fails: rollback, notify
- Health check: app must survive 30 seconds post-restart
- Failure: rollback + notify via direct curl

### Memory Pressure
- PM2 `max_memory_restart: 512M`
- `/health` shows memory for trend spotting
- Memory restart treated as crash (no user_command flag)

### Clock Drift
- Boot without NTP: log "clock not synchronized"
- After NTP sync: log "clock synchronized, offset Xms"
- Pre-sync timestamps not corrected, gap visible in logs

### Concurrent /update
- Lockfile `/tmp/home-worker-updating.lock`
- Bot checks before triggering: "Update already in progress"

## Crash-Loop Protection

PM2 `max_restarts: 10`. After 10 consecutive crashes, PM2 stops. External heartbeat detects downtime and alerts.

## Single Instance Constraint

SQLite WAL supports one writer. Never run PM2 cluster mode. Future process separation (Phase 2) is fine — multiple readers + one primary writer works with WAL. Document in README.

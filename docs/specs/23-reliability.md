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

### Google Drive API Failure
- Durable immutable attempts resume or reconcile on the next bounded cycle
- Prolonged upload/backup failures create cooldown-deduplicated admin alerts
- Files are never deleted locally without current exact-ID verification

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

| Setting | Value | Env var | Purpose |
|---|---|---|---|
| `max_restarts` | 10 | `PM2_MAX_RESTARTS` | Consecutive *unstable* restarts before PM2 parks the app in `errored` |
| `min_uptime` | 60000 ms | `PM2_MIN_UPTIME` | How long a start must survive to count as successful |
| `restart_delay` | 10000 ms | `PM2_RESTART_DELAY` | Wait between a crash and the next start |

The `PM2_*` vars are read when PM2 evaluates `ecosystem.config.js`, so they must be **exported in the shell
that invokes PM2** — e.g. `PM2_MIN_UPTIME=30000 pm2 restart ecosystem.config.js --update-env`. Nothing sources
`.env` into the PM2 CLI (`setup_pm2`, `scripts/install.sh`), so a value set only in `.env` has no effect.

`max_restarts` only counts restarts that PM2 classified as *unstable*, i.e. the process exited before
`min_uptime`. **`min_uptime` is what makes the cap engage at all.** Without it PM2 applies a 1000 ms default:
a boot-time fault that crashed the worker just over a second after start counted as a *stable* restart, so the
cap never fired — one incident logged 615 restarts with `status: online` and `unstable restarts: 0`, spinning
at roughly one crash per second for hours while Telegram and the GPIO sensors stayed down.

PM2 increments `unstable_restarts` only when the process exits *before* `min_uptime`, and resets it to 0 after
any start that outlives the window — a slow-but-legitimate start that reaches steady state is never counted, at
any value. 60 s is chosen so that every boot-phase failure lands well inside the window even on a Raspberry Pi 3
cold boot (SQLite open + migrations, sensor registry reload, feature verification, archive boot recovery), which
is what makes the cap engage at all. Mind the direction when retuning: **lowering** `min_uptime` makes PM2 more
tolerant of a fast crash loop, not less. Together with `restart_delay` it sets the retry budget —
`max_restarts × (time-to-crash + restart_delay)` ≈ 2-3 minutes of retrying before PM2 gives up.

**Accepted consequence:** a genuinely broken deploy now exhausts the cap in ~2-3 minutes and the worker stays
**down** in `errored` rather than crash-looping — no alerts until someone intervenes. That is deliberate:
`errored` is visible (`pm2 list`, external heartbeat) and recoverable (`pm2 restart`, OTA rollback, or
`pm2 resurrect` on the next boot), whereas an invisible loop is neither. `restart_delay` also helps the OTA
path: a crash-looping deploy now spends most of each cycle in `waiting restart`, so `update.sh`'s single
post-restart status sample is likely — though not guaranteed — to see something other than `online` and roll
back. `min_uptime` must stay at or above `UPDATE_HEALTH_CHECK_SEC` so that a start PM2
calls successful is at least one the OTA health check would also accept — asserted in
`test/system/infrastructure/node-runtime-contract.test.ts`.

## Single Instance Constraint

SQLite WAL supports one writer. Never run PM2 cluster mode. Future process separation (Phase 2) is fine — multiple readers + one primary writer works with WAL. Document in README.

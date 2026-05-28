# 22 — Network Module

## Dependencies
- 00-overview.md (.env `HEARTBEAT_URL`, `HEARTBEAT_INTERVAL_MS`)
- ../ports-and-adapters.md (`HeartbeatClientPort`, `NetworkProbePort`, `ClockPort`)

## Overview

The network context monitors connectivity and bot polling health and emits an external heartbeat for dead-system detection. Future: 4G failover. The application layer never imports `fetch` directly — all I/O is behind ports; all timestamps come from `ClockPort`; all logging uses Nest's `Logger`.

## Health & Polling Watcher (application/)

```typescript
// src/network/application/check-bot-polling.service.ts
@Injectable()
export class CheckBotPollingService {
  private readonly logger = new Logger(CheckBotPollingService.name);
  private lastUpdateReceived: number;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HEARTBEAT_CLIENT) private readonly heartbeat: HeartbeatClientPort,
  ) {
    this.lastUpdateReceived = clock.now().getTime();
  }

  // Called every 30s by a scheduled job
  async healthCheck(): Promise<boolean> {
    return this.heartbeat.pingTelegram();
  }

  // Wired from the bot gateway in telegram/infrastructure
  onUpdateReceived(): void {
    this.lastUpdateReceived = this.clock.now().getTime();
  }

  isBotPollingHealthy(): boolean {
    return this.clock.now().getTime() - this.lastUpdateReceived < 120_000;
  }
}
```

`HeartbeatClientPort` is implemented by `FetchHeartbeatClient` in `network/infrastructure/` — that's where `fetch(...)` and `AbortSignal.timeout(...)` live.

## Bot Polling Recovery

If `isBotPollingHealthy()` returns false:
1. Log warning: "Bot polling appears stalled"
2. Force-restart grammY runner
3. If restart fails: log error, retry in 30 seconds

This catches the scenario where WiFi drops and reconnects but the TCP socket is half-open. grammY thinks it's still polling but receives nothing.

## External Heartbeat

Worker pings an external monitoring service every `HEARTBEAT_INTERVAL_MS` (default 5 minutes). The scheduler lives in `network/application/heartbeat-scheduler.service.ts`; the actual HTTP call is `HeartbeatClientPort.pingExternal()` implemented by `FetchHeartbeatClient`.

```typescript
// application — scheduler
@Injectable()
export class HeartbeatSchedulerService {
  private readonly logger = new Logger(HeartbeatSchedulerService.name);

  constructor(@Inject(HEARTBEAT_CLIENT) private readonly client: HeartbeatClientPort) {}

  async tick(): Promise<void> {
    try {
      await this.client.pingExternal();
    } catch (err) {
      // Heartbeat failure is informational — log via Nest Logger, never console.
      this.logger.warn(`Heartbeat failed: ${(err as Error).message}`);
    }
  }
}
```

The adapter is responsible for the no-op when `HEARTBEAT_URL` is unset and for the 10 s `AbortSignal.timeout`.

- Service: UptimeRobot free tier (or any URL-ping monitor)
- If pings stop, external service sends email/SMS
- Detects: kernel panic, SD card failure, power loss, network hardware failure
- **Included in Phase 0**

## Hardware Watchdog (optional)

Pi's built-in `bcm2835_wdt`:

```bash
# Enable in install script
sudo modprobe bcm2835_wdt
echo "bcm2835_wdt" | sudo tee /etc/modules-load.d/watchdog.conf
```

Worker pets the watchdog every 15 seconds:

```typescript
// Write to /dev/watchdog every 15s
// If process dies, watchdog reboots Pi after timeout
```

## Future: 4G Failover (Phase 2)

```typescript
// Placeholder interface
async switchTo4G(): Promise<void> {
  // nmcli or mmcli commands to activate 4G modem
}

async switchToWifi(): Promise<void> {
  // Restore primary WiFi connection
}
```

Trigger: healthCheck fails N times consecutively → attempt 4G. When WiFi recovers → switch back.

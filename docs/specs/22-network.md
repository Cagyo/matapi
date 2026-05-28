# 22 — Network Module

## Dependencies
- 06-bot-core.md (grammY bot instance)
- 00-overview.md (.env HEARTBEAT_URL, HEARTBEAT_INTERVAL_MS)

## Overview

NetworkService monitors connectivity and bot health. Provides external heartbeat for dead-system detection. Future: 4G failover.

## NetworkService

```typescript
class NetworkService {
  private lastUpdateReceived: number = Date.now();

  // Called every 30 seconds
  async healthCheck(): Promise<boolean> {
    try {
      await fetch('https://api.telegram.org/bot<token>/getMe', {
        signal: AbortSignal.timeout(10000)
      });
      return true;
    } catch {
      return false;
    }
  }

  // Called by bot on every received update
  onUpdateReceived() {
    this.lastUpdateReceived = Date.now();
  }

  // Check if bot is actually receiving updates
  isBotPollingHealthy(): boolean {
    return Date.now() - this.lastUpdateReceived < 120_000; // 2 minutes
  }
}
```

## Bot Polling Recovery

If `isBotPollingHealthy()` returns false:
1. Log warning: "Bot polling appears stalled"
2. Force-restart grammY runner
3. If restart fails: log error, retry in 30 seconds

This catches the scenario where WiFi drops and reconnects but the TCP socket is half-open. grammY thinks it's still polling but receives nothing.

## External Heartbeat

Worker pings an external monitoring service periodically:

```typescript
// Called every HEARTBEAT_INTERVAL_MS (default 5 minutes)
async sendHeartbeat() {
  if (!process.env.HEARTBEAT_URL) return;

  try {
    await fetch(process.env.HEARTBEAT_URL, {
      signal: AbortSignal.timeout(10000)
    });
  } catch (err) {
    // Log but don't crash — heartbeat failure is informational
    console.warn('Heartbeat failed:', err.message);
  }
}
```

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

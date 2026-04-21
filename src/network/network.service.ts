import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Phase 0 minimal: external heartbeat ping.
 * Phase 1+: bot polling watchdog, 4G failover, etc.
 */
@Injectable()
export class NetworkService implements OnModuleInit {
  private readonly logger = new Logger(NetworkService.name);
  private timer?: NodeJS.Timeout;

  onModuleInit(): void {
    const url = process.env.HEARTBEAT_URL;
    if (!url) return;

    const interval = Number(process.env.HEARTBEAT_INTERVAL_MS || 300000);
    this.timer = setInterval(() => void this.beat(url), interval);
    this.logger.log(`Heartbeat enabled (every ${interval}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async beat(url: string): Promise<void> {
    try {
      await fetch(url, { method: 'GET' });
    } catch (err) {
      this.logger.warn(`Heartbeat failed: ${(err as Error).message}`);
    }
  }
}

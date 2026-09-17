import { Injectable } from '@nestjs/common';
import type { LiveViewSettingsJob } from '../domain/live-view-settings-job';

interface LiveViewSettingsOutcomeListener {
  notify(job: LiveViewSettingsJob): Promise<void>;
  notifyPreRestart(job: LiveViewSettingsJob): Promise<void>;
}

/** One late-bound Telegram listener; recovery can finish before the bot boots. */
@Injectable()
export class LiveViewSettingsOutcomeRegistryService {
  private listener?: LiveViewSettingsOutcomeListener;
  private pending?: LiveViewSettingsJob;

  register(listener: LiveViewSettingsOutcomeListener): void {
    this.listener = listener;
    const job = this.pending;
    this.pending = undefined;
    if (job) void this.notify(job);
  }

  async notify(job: LiveViewSettingsJob): Promise<void> {
    if (!this.listener) { this.pending = job; return; }
    await this.listener.notify(job).catch(() => undefined);
  }

  async notifyPreRestart(job: LiveViewSettingsJob): Promise<void> {
    await this.listener?.notifyPreRestart(job).catch(() => undefined);
  }
}

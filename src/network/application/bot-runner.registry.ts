import { Injectable } from '@nestjs/common';
import { BotRunnerPort } from '../domain/ports/bot-runner.port';

/**
 * Runtime register/clear seam for the Telegram runner (spec 22). Mirrors the
 * camera `AdminAlertService` pattern: the telegram `GrammyBotGateway`
 * registers itself at bootstrap, so the network context can watch and recover
 * the runner without importing the telegram module (no cycle). Until a runner
 * is registered (mock mode, or before bootstrap) every call is a safe no-op.
 */
@Injectable()
export class BotRunnerRegistry implements BotRunnerPort {
  private delegate?: BotRunnerPort;

  register(delegate: BotRunnerPort): void {
    this.delegate = delegate;
  }

  clear(): void {
    this.delegate = undefined;
  }

  /** Whether a runner is currently registered (false in mock mode). */
  hasRunner(): boolean {
    return this.delegate !== undefined;
  }

  getLastUpdateAt(): Date | null {
    return this.delegate?.getLastUpdateAt() ?? null;
  }

  isRunning(): boolean {
    return this.delegate?.isRunning() ?? false;
  }

  async restart(): Promise<void> {
    if (this.delegate) await this.delegate.restart();
  }
}

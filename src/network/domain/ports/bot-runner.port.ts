export const BOT_RUNNER = Symbol('BOT_RUNNER');

/**
 * Port the network context calls to watch and recover the Telegram long-poll
 * runner (spec 22 → Bot Polling Recovery). Owned by `network` because it is
 * the caller; the telegram context implements it (`GrammyBotGateway`) and
 * registers itself at bootstrap through `BotRunnerRegistry`, avoiding a
 * network→telegram module cycle.
 */
export interface BotRunnerPort {
  /** Timestamp of the last update received from Telegram, or `null` if none yet. */
  getLastUpdateAt(): Date | null;

  /** Whether the grammY runner currently reports itself as running. */
  isRunning(): boolean;

  /** Force-restart the grammY runner (recovers half-open polling sockets). */
  restart(): Promise<void>;
}

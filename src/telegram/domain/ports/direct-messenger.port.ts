export const DIRECT_MESSENGER = Symbol('DIRECT_MESSENGER');

/**
 * Sends a private message to a single Telegram user. Used for one-off
 * admin notifications (e.g. "you were promoted") that do not flow through
 * the fan-out `NotifierPort`.
 */
export interface DirectMessengerPort {
  send(telegramId: number, text: string): Promise<void>;
}

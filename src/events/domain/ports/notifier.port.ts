export const NOTIFIER = Symbol('NOTIFIER');

export interface NotificationMessage {
  text: string;
  asFile: boolean;
}

export interface NotifierPort {
  isReady(): boolean;
  /** Broadcast to every recipient — used by the offline drain (spec 05). */
  notify(message: NotificationMessage): Promise<void>;
  /** Deliver to a single recipient — used by per-user filtering (spec 19). */
  notifyUser(telegramId: number, message: NotificationMessage): Promise<void>;
}
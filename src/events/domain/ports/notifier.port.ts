export const NOTIFIER = Symbol('NOTIFIER');

/** Platform-neutral inline action rendered by a notification adapter. */
export interface NotificationAction {
  text: string;
  callbackData: string;
}

export interface NotificationMessage {
  text: string;
  asFile: boolean;
  /** Rows of compact actions shown below a Telegram notification. */
  actions?: NotificationAction[][];
}

/** A photo notification — a JPEG buffer with a text caption (spec 19 motion). */
export interface NotificationPhoto {
  buffer: Buffer;
  caption: string;
  /** Rows of compact actions shown below a Telegram photo notification. */
  actions?: NotificationAction[][];
}

export interface NotifierPort {
  isReady(): boolean;
  /** Broadcast to every recipient — used by the offline drain (spec 05). */
  notify(message: NotificationMessage): Promise<void>;
  /** Deliver to a single recipient — used by per-user filtering (spec 19). */
  notifyUser(telegramId: number, message: NotificationMessage): Promise<void>;
  /** Deliver a photo + caption to a single recipient (spec 19 motion event). */
  notifyUserPhoto(telegramId: number, photo: NotificationPhoto): Promise<void>;
}

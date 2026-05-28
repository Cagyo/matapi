export const NOTIFIER = Symbol('NOTIFIER');

export interface NotificationMessage {
  text: string;
  asFile: boolean;
}

export interface NotifierPort {
  isReady(): boolean;
  notify(message: NotificationMessage): Promise<void>;
}
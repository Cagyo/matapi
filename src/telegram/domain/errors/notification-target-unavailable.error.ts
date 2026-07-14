export class NotificationTargetUnavailableError extends Error {
  constructor(target: string) {
    super(`Notification target is unavailable: ${target}`);
    this.name = 'NotificationTargetUnavailableError';
  }
}

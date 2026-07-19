export const STARTUP_REPORT_MESSAGE_DELIVERY = Symbol(
  "STARTUP_REPORT_MESSAGE_DELIVERY",
);

/** A startup-report boundary that never reports success without Telegram success. */
export interface StartupReportMessageDeliveryPort {
  sendConfirmed(telegramId: number, text: string): Promise<boolean>;
}

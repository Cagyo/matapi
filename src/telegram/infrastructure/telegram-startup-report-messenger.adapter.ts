import { Injectable } from "@nestjs/common";
import type { StartupReportMessageDeliveryPort } from "../application/ports/startup-report-message-delivery.port";
import { TelegramDirectMessenger } from "./telegram-direct-messenger.adapter";

/** Startup-report-only confirmed transport; it never uses the lossy DM API. */
@Injectable()
export class TelegramStartupReportMessengerAdapter
  implements StartupReportMessageDeliveryPort
{
  constructor(private readonly transport: TelegramDirectMessenger) {}

  sendConfirmed(telegramId: number, text: string): Promise<boolean> {
    return this.transport.sendConfirmed(telegramId, text);
  }
}

import type { HomeMessageDeliveryPort } from '../application/ports/home-message-delivery.port';

type DeliveryCall =
  | { kind: 'send'; input: Parameters<HomeMessageDeliveryPort['send']>[0] }
  | { kind: 'edit'; input: Parameters<HomeMessageDeliveryPort['edit']>[0] }
  | { kind: 'stripKeyboard'; chatId: number; messageId: number }
  | { kind: 'closeMessage'; chatId: number; messageId: number; locale: Parameters<HomeMessageDeliveryPort['closeMessage']>[2] };

const MAX_RECORDED_CALLS = 100;

/** Bounded stand-in until the Telegram delivery adapter is introduced. */
export class InMemoryHomeMessageDeliveryAdapter implements HomeMessageDeliveryPort {
  readonly calls: DeliveryCall[] = [];
  sendError: Error | null = null;
  editError: Error | null = null;
  stripKeyboardError: Error | null = null;
  closeMessageError: Error | null = null;
  onSend: (() => Promise<void> | void) | null = null;
  onEdit: (() => Promise<void> | void) | null = null;
  onCloseMessage: (() => Promise<void> | void) | null = null;
  private nextMessageId = 1;

  async send(input: Parameters<HomeMessageDeliveryPort['send']>[0]): Promise<{ messageId: number }> {
    this.record({ kind: 'send', input });
    if (this.sendError) throw this.sendError;
    await this.onSend?.();
    return { messageId: this.nextMessageId++ };
  }

  async edit(input: Parameters<HomeMessageDeliveryPort['edit']>[0]): Promise<void> {
    this.record({ kind: 'edit', input });
    if (this.editError) throw this.editError;
    await this.onEdit?.();
  }

  async stripKeyboard(chatId: number, messageId: number): Promise<void> {
    this.record({ kind: 'stripKeyboard', chatId, messageId });
    if (this.stripKeyboardError) throw this.stripKeyboardError;
  }

  async closeMessage(
    chatId: number,
    messageId: number,
    locale: Parameters<HomeMessageDeliveryPort['closeMessage']>[2],
  ): Promise<void> {
    this.record({ kind: 'closeMessage', chatId, messageId, locale });
    if (this.closeMessageError) throw this.closeMessageError;
    await this.onCloseMessage?.();
  }

  private record(call: DeliveryCall): void {
    if (this.calls.length === MAX_RECORDED_CALLS) this.calls.shift();
    this.calls.push(call);
  }
}

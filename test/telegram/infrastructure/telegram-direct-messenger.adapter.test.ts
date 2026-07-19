import { describe, expect, it, vi } from "vitest";
import { TelegramDirectMessenger } from "../../../src/telegram/infrastructure/telegram-direct-messenger.adapter";

describe("TelegramDirectMessenger confirmed delivery", () => {
  it("returns false without a live bot and propagates Telegram rejection", async () => {
    const messenger = new TelegramDirectMessenger();
    await expect(messenger.sendConfirmed(100, "result")).resolves.toBe(false);

    const failure = new Error("Telegram rejected");
    messenger.setBot({
      api: { sendMessage: vi.fn().mockRejectedValue(failure) },
    } as never);

    await expect(messenger.sendConfirmed(100, "result")).rejects.toBe(failure);
  });
});

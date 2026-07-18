import { describe, expect, it, vi } from "vitest";
import { catalogFor } from "../../../src/locales/catalog";
import type { DirectMessengerPort } from "../../../src/telegram/domain/ports/direct-messenger.port";
import type { UserRepositoryPort } from "../../../src/telegram/domain/ports/user-repository.port";
import type { User } from "../../../src/telegram/domain/user.entity";
import { TelegramOtaAdminNotificationAdapter } from "../../../src/telegram/infrastructure/telegram-ota-admin-notification.adapter";

function user(
  telegramId: number,
  role: "admin" | "user",
  locale: "en" | "ru" | "uk",
): User {
  return {
    telegramId,
    name: `user-${telegramId}`,
    role,
    locale,
    muted: false,
    nonCriticalPausedUntil: null,
    notificationPauseRevision: 0,
    quietStart: null,
    quietEnd: null,
    createdAt: null,
  };
}

function harness(recipients: User[]) {
  const users = {
    listRecipients: vi.fn().mockResolvedValue(recipients),
  } as unknown as UserRepositoryPort;
  const dm: DirectMessengerPort = {
    send: vi.fn().mockResolvedValue(undefined),
  };
  return { adapter: new TelegramOtaAdminNotificationAdapter(users, dm), dm };
}

describe("TelegramOtaAdminNotificationAdapter", () => {
  it("delivers only to admins and renders each admin's locale", async () => {
    const h = harness([
      user(11, "admin", "en"),
      user(22, "user", "en"),
      user(33, "admin", "uk"),
    ]);
    const notice = {
      kind: "release-available" as const,
      version: "1.4.3",
      targetName: "linux-armv7-glibc" as const,
      commit: "0123456789abcdef0123456789abcdef01234567",
    };

    await expect(h.adapter.deliver(notice)).resolves.toEqual({ delivered: 2 });
    expect(h.dm.send).toHaveBeenCalledTimes(2);
    expect(h.dm.send).toHaveBeenCalledWith(
      11,
      catalogFor("en").ota.releaseAvailable(
        notice.version,
        notice.targetName,
        notice.commit.slice(0, 7),
      ),
    );
    expect(h.dm.send).toHaveBeenCalledWith(
      33,
      catalogFor("uk").ota.releaseAvailable(
        notice.version,
        notice.targetName,
        notice.commit.slice(0, 7),
      ),
    );
    expect(h.dm.send).not.toHaveBeenCalledWith(22, expect.any(String));
  });

  it("counts only successful sends and keeps failures local", async () => {
    const h = harness([user(11, "admin", "en"), user(33, "admin", "ru")]);
    vi.mocked(h.dm.send)
      .mockRejectedValueOnce(new Error("recipient details must remain local"))
      .mockResolvedValueOnce(undefined);

    await expect(
      h.adapter.deliver({
        kind: "discovery-failure",
        code: "signature-invalid",
      }),
    ).resolves.toEqual({ delivered: 1 });
  });

  it("returns zero when there are no administrators", async () => {
    const h = harness([user(22, "user", "en")]);

    await expect(
      h.adapter.deliver({
        kind: "discovery-failure",
        code: "metadata-expired",
      }),
    ).resolves.toEqual({ delivered: 0 });
    expect(h.dm.send).not.toHaveBeenCalled();
  });
});

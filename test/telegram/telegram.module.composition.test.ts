import 'reflect-metadata';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Provider {
  provide?: unknown;
  useClass?: unknown;
  useValue?: unknown;
}

async function telegramProviders(mode: 'mock' | 'real') {
  vi.resetModules();
  vi.stubEnv('BOT_MODE', mode);

  const { TelegramModule } = await import('../../src/telegram/telegram.module');
  const { BOT_MODE } = await import('../../src/telegram/infrastructure/grammy-bot.gateway');
  const {
    USER_REPOSITORY,
  } = await import('../../src/telegram/domain/ports/user-repository.port');
  const {
    INVITE_CODE_REPOSITORY,
  } = await import('../../src/telegram/domain/ports/invite-code-repository.port');
  const {
    USER_SENSOR_MUTE_REPOSITORY,
  } = await import('../../src/telegram/domain/ports/user-sensor-mute-repository.port');
  const {
    HOME_SESSION_STORE,
  } = await import('../../src/telegram/domain/ports/home-session-store.port');
  const {
    HOME_TOKEN_GENERATOR,
  } = await import('../../src/telegram/domain/ports/home-token-generator.port');
  const {
    HOME_MESSAGE_DELIVERY,
  } = await import('../../src/telegram/application/ports/home-message-delivery.port');
  const providers = Reflect.getMetadata('providers', TelegramModule) as Provider[];

  const providerFor = (token: unknown) => providers.find((provider) => provider.provide === token);
  return {
    mode: providerFor(BOT_MODE)?.useValue,
    userRepository: providerFor(USER_REPOSITORY)?.useClass,
    inviteCodeRepository: providerFor(INVITE_CODE_REPOSITORY)?.useClass,
    userSensorMuteRepository: providerFor(USER_SENSOR_MUTE_REPOSITORY)?.useClass,
    homeSessionStore: providerFor(HOME_SESSION_STORE)?.useClass,
    homeTokenGenerator: providerFor(HOME_TOKEN_GENERATOR)?.useClass,
    homeMessageDelivery: providerFor(HOME_MESSAGE_DELIVERY)?.useClass,
    providerClasses: providers.map((provider) => provider.useClass).filter(Boolean),
  };
}

async function resolveHomeSummaryFromApplication(mode: 'mock' | 'real') {
  const root = mkdtempSync(join(tmpdir(), 'home-worker-telegram-di-'));
  vi.resetModules();
  vi.stubEnv('BOT_MODE', mode);
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('CAMERA_MODE', 'stub');
  vi.stubEnv('SYSTEM_MODE', 'stub');
  vi.stubEnv('PIGPIOD_ENABLED', 'false');
  vi.stubEnv('DATABASE_PATH', join(root, 'worker.db'));

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { GetHomeSummaryUseCase } = await import('../../src/telegram/application/get-home-summary.use-case');
  const { NotificationTargetDirectoryService } = await import('../../src/telegram/application/notification-target-directory.service');
  const { HomeHandler } = await import('../../src/telegram/interfaces/home.handler');
  const { WorkflowEntryCoordinator } = await import('../../src/telegram/interfaces/workflow-entry.coordinator');
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  try {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    return {
      summary: app.get(GetHomeSummaryUseCase),
      targets: app.get(NotificationTargetDirectoryService),
      homeHandler: app.get(HomeHandler),
      workflowCoordinator: app.get(WorkflowEntryCoordinator),
    };
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('TelegramModule bot-mode composition', () => {
  it('uses in-memory state adapters in mock mode without booting grammY', async () => {
    const providers = await telegramProviders('mock');

    expect(providers).toMatchObject({
      mode: 'mock',
      userRepository: expect.objectContaining({ name: 'InMemoryUserRepository' }),
      inviteCodeRepository: expect.objectContaining({ name: 'InMemoryInviteCodeRepository' }),
      userSensorMuteRepository: expect.objectContaining({ name: 'InMemoryUserSensorMuteRepository' }),
      homeSessionStore: expect.objectContaining({ name: 'InMemoryHomeSessionStore' }),
      homeTokenGenerator: expect.objectContaining({ name: 'CryptoHomeTokenGenerator' }),
      homeMessageDelivery: expect.objectContaining({ name: 'InMemoryHomeMessageDeliveryAdapter' }),
    });
  }, 20_000);

  it('uses Drizzle state adapters in real mode without booting grammY', async () => {
    const providers = await telegramProviders('real');

    expect(providers).toMatchObject({
      mode: 'real',
      userRepository: expect.objectContaining({ name: 'DrizzleUserRepository' }),
      inviteCodeRepository: expect.objectContaining({ name: 'DrizzleInviteCodeRepository' }),
      userSensorMuteRepository: expect.objectContaining({ name: 'DrizzleUserSensorMuteRepository' }),
      homeSessionStore: expect.objectContaining({ name: 'DrizzleHomeSessionStore' }),
      homeTokenGenerator: expect.objectContaining({ name: 'CryptoHomeTokenGenerator' }),
      homeMessageDelivery: expect.objectContaining({ name: 'TelegramHomeMessageAdapter' }),
    });
  }, 20_000);

  it('does not register the removed Close Home use case', async () => {
    const providers = await telegramProviders('mock');

    expect(providers.providerClasses).not.toContainEqual(expect.objectContaining({ name: 'CloseHomeUseCase' }));
  });

  it.each(['mock', 'real'] as const)('resolves HomeHandler with workflow coordination at runtime in %s mode', async (mode) => {
    const { summary, targets, homeHandler, workflowCoordinator } = await resolveHomeSummaryFromApplication(mode);
    expect((summary as unknown as { notificationTargets: unknown }).notificationTargets === targets).toBe(true);
    expect((homeHandler as unknown as { workflows?: unknown }).workflows).toBe(workflowCoordinator);
  });
});

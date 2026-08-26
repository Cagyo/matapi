import 'reflect-metadata';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface ProviderDefinition {
  provide?: unknown;
  useClass?: unknown;
  useValue?: unknown;
  useExisting?: unknown;
}

type Provider = ProviderDefinition | { readonly name: string };

function isProviderDefinition(provider: Provider): provider is ProviderDefinition {
  return typeof provider === 'object' && provider !== null;
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
  const {
    CAMERA_SOURCE_PROMPT_REPOSITORY,
  } = await import('../../src/telegram/application/ports/camera-source-prompt-repository.port');
  const {
    CAMERA_SOURCE_MESSAGE,
  } = await import('../../src/telegram/application/ports/camera-source-message.port');
  const providers = Reflect.getMetadata('providers', TelegramModule) as Provider[];

  const providerFor = (token: unknown) => providers.find(
    (provider): provider is ProviderDefinition => isProviderDefinition(provider) && provider.provide === token,
  );
  return {
    mode: providerFor(BOT_MODE)?.useValue,
    userRepository: providerFor(USER_REPOSITORY)?.useClass,
    inviteCodeRepository: providerFor(INVITE_CODE_REPOSITORY)?.useClass,
    userSensorMuteRepository: providerFor(USER_SENSOR_MUTE_REPOSITORY)?.useClass,
    homeSessionStore: providerFor(HOME_SESSION_STORE)?.useClass,
    homeTokenGenerator: providerFor(HOME_TOKEN_GENERATOR)?.useClass,
    homeMessageDelivery: providerFor(HOME_MESSAGE_DELIVERY)?.useClass,
    cameraSourcePromptRepository: providerFor(CAMERA_SOURCE_PROMPT_REPOSITORY)?.useClass,
    /*
     * The whole definition, not just a class. `useExisting` and `useClass`
     * both satisfy an `instanceof` assertion, and the difference between them
     * is total: `useClass` mints a *second* adapter, so `GrammyBotGateway`
     * would hand the bot to one instance while recovery deleted through
     * another that has none — stamping `deletionFailed: true` on every row
     * while deleting nothing, with counts and tests that still look healthy.
     */
    cameraSourceMessage: providerFor(CAMERA_SOURCE_MESSAGE),
    providerClasses: providers.map((provider) => isProviderDefinition(provider) ? provider.useClass : provider)
      .filter(Boolean),
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
  const { ReadApplicationLogsUseCase } = await import('../../src/system/application/read-application-logs.use-case');
  const { NotificationTargetDirectoryService } = await import('../../src/telegram/application/notification-target-directory.service');
  const { HomeHandler } = await import('../../src/telegram/interfaces/home.handler');
  const { ApplicationLogDocumentPresenter } = await import('../../src/telegram/interfaces/application-log-document.presenter');
  const { LogsHandler } = await import('../../src/telegram/interfaces/logs.handler');
  const { WorkflowEntryCoordinator } = await import('../../src/telegram/interfaces/workflow-entry.coordinator');
  const { WorkflowNavigationHandler } = await import('../../src/telegram/interfaces/workflow-navigation.handler');
  const { WorkflowNavigationPresenter } = await import('../../src/telegram/interfaces/workflow-navigation.presenter');
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  try {
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    return {
      summary: app.get(GetHomeSummaryUseCase),
      targets: app.get(NotificationTargetDirectoryService),
      homeHandler: app.get(HomeHandler),
      readApplicationLogs: app.get(ReadApplicationLogsUseCase),
      applicationLogDocumentPresenter: app.get(ApplicationLogDocumentPresenter),
      logsHandler: app.get(LogsHandler),
      workflowCoordinator: app.get(WorkflowEntryCoordinator),
      workflowNavigation: app.get(WorkflowNavigationHandler),
      workflowPresenter: app.get(WorkflowNavigationPresenter),
    };
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The camera-source graph, resolved out of a real application container.
 *
 * Deliberately a second boot rather than more fields on the home helper: this
 * one asserts *identity*, and identity is the only thing that separates a
 * correct `useExisting` from a `useClass` that silently mints a second adapter.
 */
async function resolveCameraSourceGraph(mode: 'mock' | 'real') {
  const root = mkdtempSync(join(tmpdir(), 'home-worker-camera-source-di-'));
  vi.resetModules();
  vi.stubEnv('BOT_MODE', mode);
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('CAMERA_MODE', 'stub');
  vi.stubEnv('SYSTEM_MODE', 'stub');
  vi.stubEnv('PIGPIOD_ENABLED', 'false');
  vi.stubEnv('DATABASE_PATH', join(root, 'worker.db'));

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { CAMERA_SOURCE_MESSAGE } = await import('../../src/telegram/application/ports/camera-source-message.port');
  const { CAMERA_SOURCE_PROMPT_REPOSITORY } =
    await import('../../src/telegram/application/ports/camera-source-prompt-repository.port');
  const { DIRECT_MESSENGER } = await import('../../src/telegram/domain/ports/direct-messenger.port');
  const { RecoverCameraSourcePromptsUseCase } =
    await import('../../src/telegram/application/recover-camera-source-prompts.use-case');
  const { TelegramCameraSourceMessageAdapter } =
    await import('../../src/telegram/infrastructure/telegram-camera-source-message.adapter');
  const { TelegramDirectMessenger } = await import('../../src/telegram/infrastructure/telegram-direct-messenger.adapter');
  const { DrizzleCameraSourcePromptRepository } =
    await import('../../src/telegram/infrastructure/drizzle-camera-source-prompt.repository');
  const { InMemoryCameraSourcePromptRepository } =
    await import('../../src/telegram/infrastructure/in-memory-camera-source-prompt.repository');
  const { CameraSourcesHandler } = await import('../../src/telegram/interfaces/camera-sources.handler');

  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  try {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
    const inject = (target: unknown, field: string): unknown =>
      (target as Record<string, unknown>)[field];
    return {
      messagePort: app.get(CAMERA_SOURCE_MESSAGE),
      messageAdapter: app.get(TelegramCameraSourceMessageAdapter),
      directMessengerPort: app.get(DIRECT_MESSENGER),
      directMessenger: app.get(TelegramDirectMessenger),
      promptRepository: app.get(CAMERA_SOURCE_PROMPT_REPOSITORY),
      recovery: app.get(RecoverCameraSourcePromptsUseCase),
      handler: app.get(CameraSourcesHandler),
      inject,
      DrizzleCameraSourcePromptRepository,
      InMemoryCameraSourcePromptRepository,
      CameraSourcesHandler,
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

  it('registers the complete contextual workflow navigation provider graph', async () => {
    const providers = await telegramProviders('mock');

    expect(providers.providerClasses).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'BeginWorkflowReturnUseCase' }),
      expect.objectContaining({ name: 'UpdateWorkflowReturnUseCase' }),
      expect.objectContaining({ name: 'ClaimWorkflowReturnUseCase' }),
      expect.objectContaining({ name: 'CompleteWorkflowReturnUseCase' }),
      expect.objectContaining({ name: 'ResolveWorkflowOriginUseCase' }),
      expect.objectContaining({ name: 'RestoreWorkflowOriginUseCase' }),
      expect.objectContaining({ name: 'WorkflowDraftRegistry' }),
      expect.objectContaining({ name: 'WorkflowOperationQueue' }),
      expect.objectContaining({ name: 'WorkflowEntryCoordinator' }),
      expect.objectContaining({ name: 'WorkflowNavigationPresenter' }),
      expect.objectContaining({ name: 'WorkflowNavigationHandler' }),
    ]));
  });

  it.each(['mock', 'real'] as const)('resolves HomeHandler with workflow coordination at runtime in %s mode', async (mode) => {
    const {
      summary,
      targets,
      homeHandler,
      readApplicationLogs,
      applicationLogDocumentPresenter,
      logsHandler,
      workflowCoordinator,
      workflowNavigation,
      workflowPresenter,
    } = await resolveHomeSummaryFromApplication(mode);
    expect((summary as unknown as { notificationTargets: unknown }).notificationTargets === targets).toBe(true);
    expect((homeHandler as unknown as { workflows?: unknown }).workflows).toBe(workflowCoordinator);
    expect((homeHandler as unknown as { workflowNavigation?: unknown }).workflowNavigation)
      .toBe(workflowNavigation);
    expect(workflowNavigation).toBeTruthy();
    expect(workflowPresenter).toBeTruthy();
    expect(homeHandler).toBeDefined();
    expect(readApplicationLogs).toBeDefined();
    expect(applicationLogDocumentPresenter).toBeDefined();
    expect(logsHandler).toBeDefined();
  });

  /*
   * ─── The camera-source prompt graph ──────────────────────────────────────
   *
   * Read off the composition root rather than a container, because the storage
   * decision *is* the composition root: durable in real mode so an interrupted
   * credential deletion survives a restart, in-process in mock and test mode.
   */
  it.each([
    ['mock', 'InMemoryCameraSourcePromptRepository'],
    ['real', 'DrizzleCameraSourcePromptRepository'],
  ] as const)('stores camera source prompts in %s mode with %s', async (mode, expected) => {
    const providers = await telegramProviders(mode);

    expect(providers.cameraSourcePromptRepository).toEqual(expect.objectContaining({ name: expected }));
  }, 20_000);

  it('registers the camera source message adapter and the recovery use case exactly once', async () => {
    const providers = await telegramProviders('mock');

    expect(providers.providerClasses).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'TelegramCameraSourceMessageAdapter' }),
      expect.objectContaining({ name: 'RecoverCameraSourcePromptsUseCase' }),
    ]));
    // Aliased, not re-instantiated. `useClass` here would mint a second
    // adapter: the gateway hands the bot to one, recovery deletes through the
    // other, and every row is stamped `deletionFailed` while nothing is deleted.
    expect(providers.cameraSourceMessage).toMatchObject({
      useExisting: expect.objectContaining({ name: 'TelegramCameraSourceMessageAdapter' }),
    });
    expect(providers.cameraSourceMessage?.useClass).toBeUndefined();
  }, 20_000);

  /*
   * The identity pins, and they are the reason this file is not a formality.
   *
   * A test that only boots the container and reads a provider back proves
   * almost nothing here — see the tripwire below — so what is asserted is the
   * one thing a `useExisting` → `useClass` slip changes and an `instanceof`
   * cannot see: whether the port and the class are the *same object*.
   */
  it.each(['mock', 'real'] as const)('resolves one camera source adapter per port in %s mode', async (mode) => {
    const graph = await resolveCameraSourceGraph(mode);

    expect(graph.messagePort).toBe(graph.messageAdapter);
    // Pre-existing and equally unpinned until now, and it fails the same way.
    expect(graph.directMessengerPort).toBe(graph.directMessenger);
    expect(graph.promptRepository).toBeInstanceOf(
      mode === 'real'
        ? graph.DrizzleCameraSourcePromptRepository
        : graph.InMemoryCameraSourcePromptRepository,
    );
    // And every consumer holds those same instances rather than a private copy.
    expect(graph.inject(graph.recovery, 'prompts')).toBe(graph.promptRepository);
    expect(graph.inject(graph.recovery, 'messages')).toBe(graph.messagePort);
    expect(graph.inject(graph.handler, 'prompts')).toBe(graph.promptRepository);
    expect(graph.inject(graph.handler, 'messages')).toBe(graph.messagePort);
  }, 20_000);

  /*
   * The tripwire, and the reason every assertion above is written against an
   * explicit token.
   *
   * The test build is esbuild, which emits no `design:paramtypes`. Nest
   * therefore resolves *only* parameters carrying an explicit `@Inject(...)`;
   * every bare-class dependency is injected as `undefined`, silently. So a
   * composition test that merely asserted `CameraSourcesHandler` compiled would
   * pass with `overview`, `cameras`, `createCamera`, `attachSource`,
   * `replaceSource`, `testSource`, `removeSource`, `workflows` and `navigation`
   * all missing — which is close to meaningless, and is why the pins above
   * name tokens instead.
   *
   * Written to fail in *both* directions. If a future build emits decorator
   * metadata, this stops being true and the failure is the notice that the
   * pins above can and should be widened to the whole constructor.
   */
  it('cannot resolve bare-class dependencies under this build, which is why the pins name tokens', async () => {
    const graph = await resolveCameraSourceGraph('mock');
    const metadata = Reflect.getMetadata('design:paramtypes', graph.CameraSourcesHandler) as unknown;

    expect(metadata, 'decorator metadata is now emitted — widen the pins above').toBeUndefined();
    for (const bare of ['overview', 'cameras', 'createCamera', 'workflows', 'navigation']) {
      expect(graph.inject(graph.handler, bare), bare).toBeUndefined();
    }
    // While every explicitly tokened one does resolve, which is what the pins
    // above are actually measuring.
    for (const tokened of ['prompts', 'messages', 'clock', 'features']) {
      expect(graph.inject(graph.handler, tokened), tokened).toBeDefined();
    }
  }, 20_000);

  it('introduces no Camera↔Telegram module cycle', () => {
    const telegram = readFileSync(join(process.cwd(), 'src/telegram/telegram.module.ts'), 'utf8');
    const camera = readFileSync(join(process.cwd(), 'src/camera/camera.module.ts'), 'utf8');

    // Telegram may import Camera; Camera may never import Telegram, and neither
    // may reach for `forwardRef` to paper over a cycle between them.
    expect(telegram).toContain("from '../camera/camera.module'");
    expect(camera).not.toMatch(/from '\.\.\/telegram\//u);
    expect(camera).not.toContain('TelegramModule');
    expect(camera).not.toContain('forwardRef(');
    expect(telegram).not.toContain('forwardRef(');
  });

  it('imports the System context without reaching through its PM2 adapter or a cycle', () => {
    const moduleSource = readFileSync(
      join(process.cwd(), 'src/telegram/telegram.module.ts'),
      'utf8',
    );

    expect(moduleSource).toContain("from '../system/system.module'");
    expect(moduleSource).not.toContain('Pm2ApplicationLogReaderAdapter');
    expect(moduleSource).not.toContain('forwardRef(');
  });
});

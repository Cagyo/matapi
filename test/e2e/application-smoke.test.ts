import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module';
import { GetSnapshotUseCase } from '../../src/camera/application/get-snapshot.use-case';
import {
  CAMERA_SOURCE_AUTHORIZATION,
  CameraSourceAuthorizationPort,
} from '../../src/camera/domain/ports/camera-source-authorization.port';
import { MEDIA_REPOSITORY } from '../../src/camera/domain/ports/media-repository.port';
import { InMemoryMediaRepository } from '../../src/camera/infrastructure/in-memory-media.repository';
import { DB } from '../../src/database/database.tokens';
import { users } from '../../src/database/schema';
import { EventNotifierService } from '../../src/events/application/event-notifier.service';
import { EventProcessorService } from '../../src/events/application/event-processor.service';
import { FEATURE_READINESS } from '../../src/features/domain/ports/feature-readiness.port';
import { FEATURE_QUERY } from '../../src/features/domain/ports/feature-query.port';
import { FEATURE_REPOSITORY } from '../../src/features/domain/ports/feature-repository.port';
import { InMemoryFeatureQuery } from '../../src/features/infrastructure/in-memory-feature.query';
import { InMemoryFeatureRepository } from '../../src/features/infrastructure/in-memory-feature.repository';
import { AddSensorUseCase } from '../../src/sensors/application/add-sensor.use-case';
import { SensorRegistryService } from '../../src/sensors/application/sensor-registry.service';
import { SimulateSensorUseCase } from '../../src/sensors/application/simulate-sensor.use-case';
import { SENSOR_QUERY, SensorQueryPort } from '../../src/sensors/domain/ports/sensor-query.port';
import { MqttConnectionPool } from '../../src/sensors/infrastructure/mqtt-connection.pool';
import { SensorResourcesLifecycleAdapter } from '../../src/sensors/infrastructure/sensor-resources-lifecycle.adapter';
import { GracefulShutdownService } from '../../src/system/application/graceful-shutdown.service';
import { SYSTEM_DEPS, SystemDepsPort } from '../../src/system/domain/ports/system-deps.port';
import { SystemUpdateUseCase } from '../../src/telegram/application/system-update.use-case';
import { GrammyBotGateway } from '../../src/telegram/infrastructure/grammy-bot.gateway';

const tmpRoot = resolve('test/.tmp/e2e-smoke');
const dbPath = resolve(tmpRoot, 'smoke.db');

describe('Application E2E Smoke Integration Tests (Dev/Test Mode)', () => {
  let app: INestApplicationContext;
  const enabledFeatures = [
    { name: 'digital' as const, installed: true, enabled: true, config: null, attentionReason: null },
    { name: 'motion' as const, installed: true, enabled: true, config: null, attentionReason: null },
  ];
  const featureRepository = new InMemoryFeatureRepository(enabledFeatures);
  const featureQuery = new InMemoryFeatureQuery(enabledFeatures);
  const readiness = {
    verify: async () => ({ ready: true as const, restartScope: 'worker' as const }),
  };

  beforeAll(async () => {
    // Ensure clean tmp directory for E2E SQLite DB
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });

    // Set dev/test environment flags to ensure zero apt-get/hardware side effects
    process.env.NODE_ENV = 'test';
    process.env.BOT_MODE = 'mock';
    process.env.CAMERA_MODE = 'stub';
    process.env.SYSTEM_MODE = 'stub';
    process.env.DATABASE_PATH = dbPath;
    process.env.PIGPIOD_ENABLED = 'false';

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FEATURE_QUERY)
      .useValue(featureQuery)
      .overrideProvider(FEATURE_REPOSITORY)
      .useValue(featureRepository)
      .overrideProvider(FEATURE_READINESS)
      .useValue(readiness)
      .compile();
    await module.init();
    app = module;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('boots the complete NestJS application without external hardware or packages', () => {
    expect(app).toBeDefined();
    const db = app.get(DB);
    expect(db).toBeDefined();
  });

  it('wires MQTT resources into the sensor lifecycle owner', () => {
    const lifecycle = app.get(SensorResourcesLifecycleAdapter);
    const mqtt = app.get(MqttConnectionPool);

    expect((lifecycle as unknown as { mqtt: MqttConnectionPool }).mqtt).toBe(mqtt);
  });

  it('initializes the Telegram gateway in mock mode and binds ConsoleNotifier', () => {
    const botGateway = app.get(GrammyBotGateway);
    expect(botGateway).toBeDefined();
    expect(botGateway.isRunning()).toBe(false); // mock mode does not start polling

    const notifier = app.get(EventNotifierService);
    expect(notifier.isReady()).toBe(true);
  });

  it('checks system dependencies via stub without running apt-get or external shells', async () => {
    const systemDeps = app.get<SystemDepsPort>(SYSTEM_DEPS);
    const checkResult = await systemDeps.check();

    expect(checkResult.deps).toBeDefined();
    expect(checkResult.deps.length).toBeGreaterThan(0);
    const motionDep = checkResult.deps.find((d) => d.name === 'motion');
    expect(motionDep).toBeDefined();
    expect(motionDep?.kind).toBe('none');

    const useCase = app.get(SystemUpdateUseCase);
    const useCaseCheck = await useCase.check();
    expect(useCaseCheck).toEqual(checkResult);
  });

  it('executes full E2E sensor pipeline: add -> reload -> simulate -> notification', async () => {
    const addSensor = app.get(AddSensorUseCase);
    const registry = app.get(SensorRegistryService);
    const simulate = app.get(SimulateSensorUseCase);
    const sensorQuery = app.get<SensorQueryPort>(SENSOR_QUERY);
    const eventNotifier = app.get(EventNotifierService);
    const eventProcessor = app.get(EventProcessorService);
    const notifySpy = vi.spyOn(eventNotifier, 'notify');

    // 1. Add sensor with valid identifier (alphanumerics/underscores)
    const created = await addSensor.execute({
      name: 'smoke_door_sensor',
      type: 'digital',
      config: { pin: 21 },
      debounceMs: 500,
      severity: 'info',
    });

    // 2. Reload registry so mock driver is bound
    await registry.reload();
    const driver = registry.getDriver(created.id);
    expect(driver).toBeDefined();

    // 3. Simulate state transition (0 -> 1)
    simulate.execute(created.id, 1);

    // Wait for the async driver -> registry handoff to reach the event processor.
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalled(), { timeout: 2000 });
    await eventProcessor.waitForIdle(2000);

    // 4. Verify DB recorded state update
    const lookup = await sensorQuery.findByName('smoke_door_sensor');
    expect(lookup).toBeDefined();
    expect(lookup?.kind).toBe('active');
    if (lookup?.kind === 'active') {
      expect(lookup.sensor.lastValue).toBe('1');
    }

    notifySpy.mockRestore();
  });

  it('executes camera stub snapshot pipeline end-to-end', async () => {
    const mediaRepo = app.get<InMemoryMediaRepository>(MEDIA_REPOSITORY);
    mediaRepo.seedCameras([{
      id: 'front_door_cam',
      name: 'front_door_cam',
      type: 'rtsp',
      config: null,
      enabled: true,
    }]);

    const getSnapshot = app.get(GetSnapshotUseCase);
    const result = await getSnapshot.execute('front_door_cam');

    expect(result).toBeDefined();
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.cameraName).toBe('front_door_cam');
  });

  it('binds the Telegram role authority into the camera authorization registry', () => {
    // The registry is fail-closed, so only a registered adapter can produce a
    // success: this passing proves the late-binding registration actually ran.
    const db = app.get(DB);
    db.insert(users).values({
      telegramId: 424_242,
      name: 'smoke_admin',
      role: 'admin',
    }).run();

    const authorization = app.get<CameraSourceAuthorizationPort>(CAMERA_SOURCE_AUTHORIZATION);

    expect(() => authorization.requireAdmin(424_242)).not.toThrow();
  });

  it('executes graceful shutdown coordinator without errors', async () => {
    const shutdownService = app.get(GracefulShutdownService);
    expect(shutdownService).toBeDefined();
    // Verify run does not throw
    await expect(shutdownService.run('SIGTERM')).resolves.not.toThrow();
  });
});

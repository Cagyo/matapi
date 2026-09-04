import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveModule } from '../../src/archive/archive.module';
import { AppModule } from '../../src/app.module';
import { CameraModule } from '../../src/camera/camera.module';
import { TelegramModule } from '../../src/telegram/telegram.module';
import { ARCHIVE_REGISTRATION } from '../../src/archive/application/ports/archive-registration.port';
import { ARCHIVE_REGISTRATION_LOOKUP } from '../../src/archive/application/ports/archive-registration-lookup.port';
import { ARCHIVE_RUNTIME_SIGNAL } from '../../src/archive/application/ports/archive-runtime-signal.port';
import { ARCHIVE_VERIFICATION } from '../../src/archive/application/ports/archive-verification.port';
import { ARCHIVE_ADMIN_ALERT } from '../../src/archive/application/ports/archive-admin-alert.port';
import { ARCHIVE_ARTIFACT_REPOSITORY } from '../../src/archive/application/ports/archive-artifact-repository.port';
import { ArchiveRemoteMutationLockService } from '../../src/archive/application/archive-remote-mutation-lock.service';
import { ReconcileDriveUseCase } from '../../src/archive/application/use-cases/reconcile-drive.use-case';
import { ArchiveRuntimeLifecycleService } from '../../src/archive/application/archive-runtime-lifecycle.service';
import { ArchiveAdminAlertService } from '../../src/archive/application/archive-admin-alert.service';
import { ReportDriveStatusUseCase } from '../../src/archive/application/use-cases/report-drive-status.use-case';
import { CLOCK } from '../../src/events/domain/ports/clock.port';
import { DRIVE_DEVICE_AUTHORIZATION } from '../../src/archive/application/ports/drive-device-authorization.port';
import { ArchiveSchedulerHooksService } from '../../src/archive/application/archive-scheduler.service';
import { ArchiveSchedulerService } from '../../src/archive/application/archive-scheduler.service';
import { ArchiveWakeService } from '../../src/archive/application/archive-wake.service';
import { ArchiveProviderGateService } from '../../src/archive/application/archive-provider-gate.service';
import { ARCHIVE_PROVIDER_STATE_REPOSITORY } from '../../src/archive/application/ports/archive-provider-state-repository.port';
import { DRIVE_FOLDER } from '../../src/archive/application/ports/drive-folder.port';
import { DRIVE_FOLDER_RESERVATION_REPOSITORY } from '../../src/archive/application/ports/drive-folder-reservation-repository.port';
import { DRIVE_QUOTA_PROBE } from '../../src/archive/application/ports/drive-quota-probe.port';
import { ResolveMotionArchiveContainerUseCase } from '../../src/archive/application/use-cases/resolve-motion-archive-container.use-case';
import { FindRegisteredArchiveArtifactUseCase } from '../../src/archive/application/use-cases/find-registered-archive-artifact.use-case';
import { ProbeDriveQuotaRecoveryUseCase } from '../../src/archive/application/use-cases/probe-drive-quota-recovery.use-case';
import { RevalidateMotionArchiveBranchUseCase } from '../../src/archive/application/use-cases/revalidate-motion-archive-branch.use-case';
import { RetryDriveArchiveUseCase } from '../../src/archive/application/use-cases/retry-drive-archive.use-case';
import { ArchiveClockHealthService } from '../../src/archive/application/archive-clock-health.service';
import {
  DriveAuthorizationOutcomeRegistrationService,
} from '../../src/archive/application/drive-authorization-polling.service';
import { BeginDriveConnectionUseCase } from '../../src/archive/application/use-cases/begin-drive-connection.use-case';
import { SubmitDriveClientUseCase } from '../../src/archive/application/use-cases/submit-drive-client.use-case';
import { ConfirmDriveAccountUseCase } from '../../src/archive/application/use-cases/confirm-drive-account.use-case';
import { CancelDriveConnectionUseCase } from '../../src/archive/application/use-cases/cancel-drive-connection.use-case';
import { DisconnectDriveUseCase } from '../../src/archive/application/use-cases/disconnect-drive.use-case';
import { RetireDriveConnectionUseCase } from '../../src/archive/application/use-cases/retire-drive-connection.use-case';
import { UploadDriveObjectAttemptUseCase } from '../../src/archive/application/use-cases/upload-drive-object-attempt.use-case';
import { ARCHIVE_CLOCK } from '../../src/archive/application/ports/archive-clock.port';
import { ApplyDriveRetentionUseCase } from '../../src/archive/application/use-cases/apply-drive-retention.use-case';
import { VerifyArchiveArtifactUseCase } from '../../src/archive/application/use-cases/verify-archive-artifact.use-case';
import { ARCHIVE_RETENTION } from '../../src/archive/application/ports/archive-retention.port';
import { DRIVE_ACCOUNT } from '../../src/archive/application/ports/drive-account.port';
import { DRIVE_CREDENTIAL_REPOSITORY } from '../../src/archive/application/ports/drive-credential-repository.port';
import { DriveClockUnhealthyError } from '../../src/archive/domain/errors/drive-clock-unhealthy.error';
import { DriveRateLimitedError } from '../../src/archive/domain/errors/drive-rate-limited.error';
import { InMemoryArchiveProviderStateRepository } from '../../src/archive/infrastructure/persistence/in-memory-archive-provider-state.repository';
import { GoogleDriveConnectionAccountAdapter } from '../../src/archive/infrastructure/google/google-drive-connection-account.adapter';
import { NestFactory } from '@nestjs/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

describe('ArchiveModule composition', () => {
  it('is imported by the application, Camera, and Telegram composition roots', () => {
    expect(Reflect.getMetadata('imports', AppModule)).toContain(ArchiveModule);
    expect(Reflect.getMetadata('imports', CameraModule)).toContain(ArchiveModule);
    expect(Reflect.getMetadata('imports', TelegramModule)).toContain(ArchiveModule);
  });

  it('exports ports, connection use cases, lifecycle, and registration seams without concrete adapters', () => {
    const exports = Reflect.getMetadata('exports', ArchiveModule) as unknown[];
    expect(exports).toEqual(expect.arrayContaining([
      ARCHIVE_REGISTRATION,
      ARCHIVE_RUNTIME_SIGNAL,
      ARCHIVE_VERIFICATION,
      ARCHIVE_RETENTION,
      BeginDriveConnectionUseCase,
      SubmitDriveClientUseCase,
      ConfirmDriveAccountUseCase,
      CancelDriveConnectionUseCase,
      DisconnectDriveUseCase,
      ArchiveRuntimeLifecycleService,
      ArchiveSchedulerHooksService,
      ArchiveRemoteMutationLockService,
      DriveAuthorizationOutcomeRegistrationService,
      ArchiveAdminAlertService,
      ReportDriveStatusUseCase,
    ]));
    expect(exports.some((value) => typeof value === 'function' && /Adapter|Repository/u.test(value.name))).toBe(false);
    expect(exports).not.toContain(ApplyDriveRetentionUseCase);
  });

  it('binds every durable date-folder, provider-gate, wake, and runtime-signal seam', () => {
    const providers = Reflect.getMetadata('providers', ArchiveModule) as ProviderRecord[];
    const tokens = providers.map((provider) => providerToken(provider));

    expect(tokens).toEqual(expect.arrayContaining([
      DRIVE_FOLDER,
      DRIVE_FOLDER_RESERVATION_REPOSITORY,
      ARCHIVE_PROVIDER_STATE_REPOSITORY,
      ResolveMotionArchiveContainerUseCase,
      ArchiveProviderGateService,
      ArchiveWakeService,
      ARCHIVE_RUNTIME_SIGNAL,
    ]));
    expect(providerFor(providers, ARCHIVE_RUNTIME_SIGNAL)).toMatchObject({
      useExisting: ArchiveSchedulerService,
    });
  });

  it('binds every recovery collaborator explicitly to its intended singleton', () => {
    const providers = Reflect.getMetadata('providers', ArchiveModule) as ProviderRecord[];

    expect(providerFor(providers, ARCHIVE_REGISTRATION_LOOKUP)).toMatchObject({
      useExisting: FindRegisteredArchiveArtifactUseCase,
    });
    expect(providerFor(providers, FindRegisteredArchiveArtifactUseCase).inject).toEqual([
      ARCHIVE_ARTIFACT_REPOSITORY,
    ]);
    expect(providerFor(providers, DRIVE_QUOTA_PROBE)).toMatchObject({
      useExisting: GoogleDriveConnectionAccountAdapter,
    });
    expect(providerFor(providers, RevalidateMotionArchiveBranchUseCase).inject).toEqual([
      DRIVE_FOLDER,
      DRIVE_FOLDER_RESERVATION_REPOSITORY,
      ArchiveRemoteMutationLockService,
      ARCHIVE_ADMIN_ALERT,
    ]);
    expect(providerFor(providers, ArchiveClockHealthService).inject).toEqual([
      ARCHIVE_ARTIFACT_REPOSITORY,
      ArchiveWakeService,
    ]);
    expect(providerFor(providers, ProbeDriveQuotaRecoveryUseCase).inject).toEqual([
      ARCHIVE_ARTIFACT_REPOSITORY,
      DRIVE_QUOTA_PROBE,
      ArchiveProviderGateService,
      CLOCK,
    ]);
    expect(providerFor(providers, RetryDriveArchiveUseCase).inject).toEqual([
      ARCHIVE_PROVIDER_STATE_REPOSITORY,
      DRIVE_FOLDER_RESERVATION_REPOSITORY,
      CLOCK,
      ArchiveWakeService,
    ]);
    expect(providerFor(providers, ArchiveSchedulerService).inject?.slice(-4)).toEqual([
      ArchiveClockHealthService,
      RevalidateMotionArchiveBranchUseCase,
      ProbeDriveQuotaRecoveryUseCase,
      DRIVE_QUOTA_PROBE,
    ]);
    expect(providerFor(providers, ArchiveRuntimeLifecycleService).inject?.at(-1))
      .toBe(ArchiveClockHealthService);
  });

  it('injects one shared mutation lock and provider gate across active-generation work', () => {
    const providers = Reflect.getMetadata('providers', ArchiveModule) as ProviderRecord[];

    for (const token of [
      ConfirmDriveAccountUseCase,
      RetireDriveConnectionUseCase,
      ResolveMotionArchiveContainerUseCase,
      ApplyDriveRetentionUseCase,
      UploadDriveObjectAttemptUseCase,
      ArchiveSchedulerService,
    ]) {
      expect(providerFor(providers, token).inject).toContain(ArchiveRemoteMutationLockService);
    }
    for (const token of [
      ResolveMotionArchiveContainerUseCase,
      UploadDriveObjectAttemptUseCase,
      ArchiveSchedulerService,
    ]) {
      expect(providerFor(providers, token).inject).toContain(ArchiveProviderGateService);
    }
    expect(providerFor(providers, ConfirmDriveAccountUseCase).inject).toEqual([
      DRIVE_CREDENTIAL_REPOSITORY,
      GoogleDriveConnectionAccountAdapter,
      CLOCK,
      ArchiveWakeService,
      ArchiveRemoteMutationLockService,
      ArchiveProviderGateService,
      DRIVE_FOLDER_RESERVATION_REPOSITORY,
    ]);
    expect(providerFor(providers, VerifyArchiveArtifactUseCase).inject)
      .toContain(ArchiveProviderGateService);
    expect(providerFor(providers, ARCHIVE_VERIFICATION)).toMatchObject({
      useExisting: VerifyArchiveArtifactUseCase,
    });
    expect(providerFor(providers, ReportDriveStatusUseCase).inject).toEqual(expect.arrayContaining([
      DRIVE_ACCOUNT,
      ARCHIVE_PROVIDER_STATE_REPOSITORY,
      ArchiveSchedulerService,
    ]));
  });

  it('shares one resolved scheduler interval with the provider wait clamp', () => {
    const providers = Reflect.getMetadata('providers', ArchiveModule) as ProviderRecord[];
    const gateProvider = providerFor(providers, ArchiveProviderGateService);
    const schedulerProvider = providerFor(providers, ArchiveSchedulerService);
    const schedulerOptionsToken = gateProvider.inject?.[2];
    const repository = {
      load: vi.fn(async () => ({
        revision: 0, generationId: null, operationClass: null, failureClass: null,
        failureStreak: 0, cooldownUntilMs: null, blockReason: null, updatedAtMs: 0,
      })),
      activateGeneration: vi.fn(async () => true),
      compareAndSet: vi.fn(async () => true),
    };
    const gate = gateProvider.useFactory?.(
      repository,
      { now: () => new Date(0) },
      { intervalMs: 30_000, leaseMs: 300_000, newerVideoBatch: 3 },
    ) as ArchiveProviderGateService;

    expect(schedulerOptionsToken).toBeDefined();
    expect(schedulerProvider.inject).toContain(schedulerOptionsToken);
    expect((gate as unknown as { maximumSleepMs: number }).maximumSleepMs).toBe(30_000);
  });

  it('keeps infrastructure dependencies behind Archive boundaries', () => {
    const root = resolve(process.cwd(), 'src');
    const violations: string[] = [];
    for (const file of typescriptFiles(resolve(root, 'camera'))) {
      const source = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*archive\/infrastructure(?:\/|['"])/u.test(source)) {
        violations.push(relative(root, file));
      }
    }
    for (const layer of ['application', 'domain']) {
      for (const file of typescriptFiles(resolve(root, 'archive', layer))) {
        const source = readFileSync(file, 'utf8');
        if (/from\s+['"](?:@googleapis\/drive|drizzle-orm(?:\/[^'"]*)?|[^'"]*camera\/infrastructure(?:\/|['"]))/u.test(source)) {
          violations.push(relative(root, file));
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('bootstraps the actual Archive and Camera composition graph', async () => {
    const previousDatabasePath = process.env.DATABASE_PATH;
    const directory = await mkdtemp(join(tmpdir(), 'archive-composition-'));
    process.env.DATABASE_PATH = join(directory, 'worker.sqlite');
    const app = await NestFactory.createApplicationContext(CameraModule, { logger: false });
    try {
      expect(app.get(ARCHIVE_REGISTRATION)).toBeDefined();
      expect(app.get(ARCHIVE_VERIFICATION)).toBeDefined();
      expect(app.get(ARCHIVE_RETENTION)).toBeDefined();
      expect(app.get(ARCHIVE_REGISTRATION_LOOKUP))
        .toBe(app.get(FindRegisteredArchiveArtifactUseCase));
      expect(app.get(DRIVE_QUOTA_PROBE))
        .toBe(app.get(GoogleDriveConnectionAccountAdapter));

      const clockHealth = app.get(ArchiveClockHealthService);
      const branchProbe = app.get(RevalidateMotionArchiveBranchUseCase);
      const quotaProbe = app.get(ProbeDriveQuotaRecoveryUseCase);
      const accountProbe = app.get(DRIVE_QUOTA_PROBE);
      const reservations = app.get(DRIVE_FOLDER_RESERVATION_REPOSITORY);
      const confirm = app.get<{ reservations: unknown }>(ConfirmDriveAccountUseCase);
      const scheduler = app.get<{
        clockHealth: unknown;
        branchProbe: unknown;
        quotaProbe: unknown;
        accountProbe: unknown;
      }>(ArchiveSchedulerService);
      const lifecycle = app.get<{
        clockHealth: unknown;
      }>(ArchiveRuntimeLifecycleService);
      expect(app.get(RetryDriveArchiveUseCase)).toBeDefined();
      expect(scheduler.clockHealth).toBe(clockHealth);
      expect(scheduler.branchProbe).toBe(branchProbe);
      expect(scheduler.quotaProbe).toBe(quotaProbe);
      expect(scheduler.accountProbe).toBe(accountProbe);
      expect(confirm.reservations).toBe(reservations);
      expect(lifecycle.clockHealth).toBe(clockHealth);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
      if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousDatabasePath;
    }
  });

  it('injects a real clock token into cooldown persistence', () => {
    const parameters = Reflect.getMetadata('self:paramtypes', ArchiveAdminAlertService) as
      | readonly { index: number; param: unknown }[]
      | undefined;
    expect(parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ index: 1, param: CLOCK }),
    ]));
  });

  it('injects the shared CLOCK into every Drive setup time consumer', () => {
    const providers = Reflect.getMetadata('providers', ArchiveModule) as ProviderRecord[];

    expect(providerFor(providers, DRIVE_DEVICE_AUTHORIZATION).inject).toContain(CLOCK);
    expect(providerFor(providers, BeginDriveConnectionUseCase).inject).toContain(CLOCK);
    expect(providerFor(providers, SubmitDriveClientUseCase).inject).toContain(CLOCK);
    expect(providerFor(providers, ConfirmDriveAccountUseCase).inject).toContain(CLOCK);
  });

  it('clears the adapter sleep timer and preserves the caller abort reason', async () => {
    vi.useFakeTimers();
    try {
      const providers = Reflect.getMetadata('providers', ArchiveModule) as ProviderRecord[];
      const provider = providerFor(providers, DRIVE_DEVICE_AUTHORIZATION);
      const fixedNow = new Date('2026-08-12T10:00:00.000Z');
      const adapter = provider.useFactory?.({ now: () => fixedNow }) as {
        clock: {
          now(): number;
          sleep(ms: number, signal: AbortSignal): Promise<void>;
        };
      };
      const controller = new AbortController();
      const reason = new DOMException('Exact setup cancelled', 'AbortError');

      expect(adapter.clock.now()).toBe(fixedNow.getTime());
      const sleeping = adapter.clock.sleep(60_000, controller.signal);
      controller.abort(reason);

      await expect(sleeping).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds a mandatory durable admin-alert adapter into reconciliation', () => {
    const providers = Reflect.getMetadata('providers', ArchiveModule) as {
      provide?: unknown;
      inject?: unknown[];
    }[];
    expect(providers.some(
      (provider) => provider.provide === ARCHIVE_ADMIN_ALERT,
    )).toBe(true);
    const reconcile = providers.find(
      (provider) => provider.provide === ReconcileDriveUseCase,
    );
    expect(reconcile).toMatchObject({ inject: expect.arrayContaining([ARCHIVE_ADMIN_ALERT]) });
  });

  it('wires the healthy archive clock and exact-ID retention into scheduled maintenance', () => {
    const providers = Reflect.getMetadata('providers', ArchiveModule) as {
      provide?: unknown;
      inject?: unknown[];
    }[];

    expect(providers.some((provider) => provider.provide === ARCHIVE_CLOCK)).toBe(true);
    expect(providers.some((provider) => provider.provide === ApplyDriveRetentionUseCase)).toBe(true);
    expect(providers).toContainEqual(expect.objectContaining({
      provide: ARCHIVE_RETENTION,
      useExisting: ApplyDriveRetentionUseCase,
    }));
    const maintenance = providers.find((provider) =>
      typeof provider.provide === 'symbol' &&
      provider.inject?.includes(ReconcileDriveUseCase) &&
      provider.inject?.includes(ARCHIVE_RETENTION) &&
      provider.inject?.includes(ARCHIVE_ADMIN_ALERT),
    );
    expect(maintenance).toBeDefined();
  });

  it('runs reconciliation before retention through the registered maintenance hook', async () => {
    const order: string[] = [];
    const hooks = new ArchiveSchedulerHooksService();
    const provider = remoteMaintenanceProvider();
    provider.useFactory(
      hooks,
      { execute: vi.fn(async () => { order.push('reconcile'); }) },
      { execute: vi.fn(async () => { order.push('retention'); }) },
      { alert: vi.fn(async () => undefined) },
      { loadActive: vi.fn(async () => null) },
      { run: vi.fn(async ({ operation }: { operation(): Promise<unknown> }) => operation()) },
      new ArchiveRemoteMutationLockService(),
    );

    await hooks.runRemoteMaintenance(
      new ArchiveRemoteMutationLockService(),
      new AbortController().signal,
    );

    expect(order).toEqual(['reconcile', 'retention']);
  });

  it('settles a delete-owned recovery probe through retention before reconciliation', async () => {
    const order: string[] = [];
    const clock = { value: 1_000 };
    const repository = new InMemoryArchiveProviderStateRepository();
    const gate = new ArchiveProviderGateService(
      repository,
      { now: () => new Date(clock.value) },
      { sleep: async () => undefined },
      { random: () => 0 },
    );
    await gate.ensureGeneration('generation-1');
    await gate.recordFailure('generation-1', 'delete', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: false, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    const hooks = new ArchiveSchedulerHooksService();
    const provider = remoteMaintenanceProvider();
    const retention = {
      execute: vi.fn(async () => gate.run({
        generationId: 'generation-1',
        operationClass: 'delete',
        probe: true,
        operation: async () => { order.push('retention'); },
      })),
    };
    provider.useFactory(
      hooks,
      { execute: vi.fn(async () => { order.push('reconcile'); }) },
      retention,
      { alert: vi.fn(async () => undefined) },
      { loadActive: vi.fn(async () => ({ id: 'generation-1', status: 'active' })) },
      gate,
      new ArchiveRemoteMutationLockService(),
    );

    await hooks.runRemoteMaintenance(
      new ArchiveRemoteMutationLockService(),
      new AbortController().signal,
    );

    expect(order).toEqual(['retention', 'reconcile']);
    expect(retention.execute).toHaveBeenCalledOnce();
    await expect(repository.load()).resolves.toMatchObject({
      operationClass: null,
      failureClass: null,
      cooldownUntilMs: null,
    });
  });

  it('fails retention closed on an unhealthy clock while keeping maintenance available', async () => {
    const hooks = new ArchiveSchedulerHooksService();
    const alert = vi.fn(async () => undefined);
    const provider = remoteMaintenanceProvider();
    provider.useFactory(
      hooks,
      { execute: vi.fn(async () => undefined) },
      { execute: vi.fn(async () => { throw new DriveClockUnhealthyError(); }) },
      { alert },
      { loadActive: vi.fn(async () => null) },
      { run: vi.fn(async ({ operation }: { operation(): Promise<unknown> }) => operation()) },
      new ArchiveRemoteMutationLockService(),
    );

    await expect(hooks.runRemoteMaintenance(
      new ArchiveRemoteMutationLockService(),
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledWith('clock-unhealthy', {
      generationId: '',
      errorCode: 'DRIVE_CLOCK_UNHEALTHY',
    });
  });
});

interface ProviderRecord {
  provide?: unknown;
  inject?: unknown[];
  useExisting?: unknown;
  useFactory?: (...dependencies: unknown[]) => unknown;
}

function providerToken(provider: ProviderRecord): unknown {
  return typeof provider === 'object' && provider !== null && 'provide' in provider
    ? provider.provide
    : provider;
}

function providerFor(providers: ProviderRecord[], token: unknown): ProviderRecord {
  const provider = providers.find((candidate) => candidate.provide === token);
  if (!provider) throw new Error(`Provider not found: ${String(token)}`);
  return provider;
}

function remoteMaintenanceProvider(): {
  useFactory: (...dependencies: unknown[]) => unknown;
} {
  const providers = Reflect.getMetadata('providers', ArchiveModule) as {
    provide?: unknown;
    inject?: unknown[];
    useFactory?: (...dependencies: unknown[]) => unknown;
  }[];
  const provider = providers.find((candidate) =>
    candidate.inject?.includes(ReconcileDriveUseCase) &&
    candidate.inject?.includes(ARCHIVE_RETENTION),
  );
  if (provider?.useFactory === undefined) throw new Error('Remote maintenance provider is missing');
  return { useFactory: provider.useFactory };
}

function typescriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

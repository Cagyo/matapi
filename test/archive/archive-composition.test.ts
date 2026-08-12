import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveModule } from '../../src/archive/archive.module';
import { AppModule } from '../../src/app.module';
import { CameraModule } from '../../src/camera/camera.module';
import { TelegramModule } from '../../src/telegram/telegram.module';
import { ARCHIVE_REGISTRATION } from '../../src/archive/application/ports/archive-registration.port';
import { ARCHIVE_VERIFICATION } from '../../src/archive/application/ports/archive-verification.port';
import { ARCHIVE_ADMIN_ALERT } from '../../src/archive/application/ports/archive-admin-alert.port';
import { ArchiveRemoteMutationLockService } from '../../src/archive/application/archive-remote-mutation-lock.service';
import { ReconcileDriveUseCase } from '../../src/archive/application/use-cases/reconcile-drive.use-case';
import { ArchiveRuntimeLifecycleService } from '../../src/archive/application/archive-runtime-lifecycle.service';
import { ArchiveAdminAlertService } from '../../src/archive/application/archive-admin-alert.service';
import { ReportDriveStatusUseCase } from '../../src/archive/application/use-cases/report-drive-status.use-case';
import { CLOCK } from '../../src/events/domain/ports/clock.port';
import { DRIVE_DEVICE_AUTHORIZATION } from '../../src/archive/application/ports/drive-device-authorization.port';
import { ArchiveSchedulerHooksService } from '../../src/archive/application/archive-scheduler.service';
import {
  DriveAuthorizationOutcomeRegistrationService,
} from '../../src/archive/application/drive-authorization-polling.service';
import { BeginDriveConnectionUseCase } from '../../src/archive/application/use-cases/begin-drive-connection.use-case';
import { SubmitDriveClientUseCase } from '../../src/archive/application/use-cases/submit-drive-client.use-case';
import { ConfirmDriveAccountUseCase } from '../../src/archive/application/use-cases/confirm-drive-account.use-case';
import { CancelDriveConnectionUseCase } from '../../src/archive/application/use-cases/cancel-drive-connection.use-case';
import { DisconnectDriveUseCase } from '../../src/archive/application/use-cases/disconnect-drive.use-case';
import { ARCHIVE_CLOCK } from '../../src/archive/application/ports/archive-clock.port';
import { ApplyDriveRetentionUseCase } from '../../src/archive/application/use-cases/apply-drive-retention.use-case';
import { ARCHIVE_RETENTION } from '../../src/archive/application/ports/archive-retention.port';
import { DriveClockUnhealthyError } from '../../src/archive/domain/errors/drive-clock-unhealthy.error';
import { NestFactory } from '@nestjs/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('bootstraps the actual Archive and Camera composition graph', async () => {
    const previousDatabasePath = process.env.DATABASE_PATH;
    const directory = await mkdtemp(join(tmpdir(), 'archive-composition-'));
    process.env.DATABASE_PATH = join(directory, 'worker.sqlite');
    const app = await NestFactory.createApplicationContext(CameraModule, { logger: false });
    try {
      expect(app.get(ARCHIVE_REGISTRATION)).toBeDefined();
      expect(app.get(ARCHIVE_VERIFICATION)).toBeDefined();
      expect(app.get(ARCHIVE_RETENTION)).toBeDefined();
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
    );

    await hooks.runRemoteMaintenance(
      new ArchiveRemoteMutationLockService(),
      new AbortController().signal,
    );

    expect(order).toEqual(['reconcile', 'retention']);
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
  useFactory?: (...dependencies: unknown[]) => unknown;
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

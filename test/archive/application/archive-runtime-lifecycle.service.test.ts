import { describe, expect, it, vi } from 'vitest';
import type { ArchiveArtifactRepositoryPort } from '../../../src/archive/application/ports/archive-artifact-repository.port';
import type { DriveCredentialRepositoryPort } from '../../../src/archive/application/ports/drive-credential-repository.port';
import { ArchiveRuntimeLifecycleService } from '../../../src/archive/application/archive-runtime-lifecycle.service';
import { ArchiveSchedulerHooksService } from '../../../src/archive/application/archive-scheduler.service';
import type { ArchiveSchedulerService } from '../../../src/archive/application/archive-scheduler.service';
import type { DriveAuthorizationPollingService } from '../../../src/archive/application/drive-authorization-polling.service';
import type { RetireDriveConnectionUseCase } from '../../../src/archive/application/use-cases/retire-drive-connection.use-case';
import type { CreateDatabaseBackupUseCase } from '../../../src/archive/application/use-cases/create-database-backup.use-case';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import type { ClockPort } from '../../../src/events/domain/ports/clock.port';
import { ArchiveWakeService } from '../../../src/archive/application/archive-wake.service';

function connection(
  status: 'retiring' | 'disconnecting',
  id = status,
  createdAtMs = 1,
): DriveConnection {
  return DriveConnection.restore({
    id, installationId: 'installation-1', status, revision: 1,
    permissionId: 'permission-1', email: null, displayName: null,
    folders: { rootId: 'root', motionId: 'motion', backupsId: 'backups' },
    createdAtMs, updatedAtMs: 2, activatedAtMs: 1, retiredAtMs: null,
  });
}

describe('ArchiveRuntimeLifecycleService', () => {
  it('wakes the pump after boot recovery starts archive scheduling', async () => {
    const wake = new ArchiveWakeService();
    const wakeSpy = vi.spyOn(wake, 'wake');
    const scheduler = { startTimers: vi.fn(), shutdown: vi.fn(async () => undefined) };
    const lifecycle = new ArchiveRuntimeLifecycleService(
      { expireStaged: vi.fn(async () => []), listInterruptedMaintenance: vi.fn(async () => []) },
      {
        recoverExpiredLeases: vi.fn(async () => 0),
        listUnverifiedArtifactPaths: vi.fn(async () => []),
      } as unknown as ArchiveArtifactRepositoryPort,
      { execute: vi.fn() },
      { cancelAll: vi.fn() },
      { removeStaleTemporarySnapshots: vi.fn(async () => 0) },
      { execute: vi.fn(async () => ({ created: false, reason: 'not_due' })) },
      scheduler,
      new ArchiveSchedulerHooksService(),
      { now: () => new Date(1_000) },
      undefined,
      wake,
    );

    await lifecycle.start();

    expect(scheduler.startTimers).toHaveBeenCalledOnce();
    expect(wakeSpy).toHaveBeenCalledOnce();
  });

  it('recovers retiring and disconnecting generations before normal scheduling', async () => {
    const order: string[] = [];
    const credentials = {
      expireStaged: vi.fn(async () => { order.push('expire-staged'); return []; }),
      listInterruptedMaintenance: vi.fn(async () => [
        connection('disconnecting'),
        connection('retiring', 'retiring-b', 2),
        connection('retiring', 'retiring-a', 1),
      ]),
    } as unknown as DriveCredentialRepositoryPort;
    const repository = {
      releaseGenerationLeases: vi.fn(async () => undefined),
      clearGenerationSessions: vi.fn(async () => undefined),
      recoverExpiredLeases: vi.fn(async () => { order.push('recover-leases'); return 0; }),
      listUnverifiedArtifactPaths: vi.fn(async () => []),
    } as unknown as ArchiveArtifactRepositoryPort;
    const retire = {
      execute: vi.fn(async (candidate: DriveConnection) => {
        order.push(candidate.status === 'retiring' ? `retire:${candidate.id}` : 'disconnect');
      }),
    } as unknown as RetireDriveConnectionUseCase;
    const scheduler = {
      startTimers: vi.fn(() => { order.push('schedule'); }), shutdown: vi.fn(async () => undefined),
    } as unknown as ArchiveSchedulerService;
    const lifecycle = new ArchiveRuntimeLifecycleService(
      credentials,
      repository,
      retire,
      { cancelAll: vi.fn() },
      { removeStaleTemporarySnapshots: vi.fn(async () => 0) },
      { execute: vi.fn(async () => ({ created: false, reason: 'not_due' })) } as unknown as CreateDatabaseBackupUseCase,
      scheduler,
      new ArchiveSchedulerHooksService(),
      { now: () => new Date(1_000) } satisfies ClockPort,
    );

    await lifecycle.start();

    expect(order).toEqual([
      'expire-staged', 'retire:retiring-a', 'retire:retiring-b',
      'disconnect', 'recover-leases', 'schedule',
    ]);
  });

  it('runs boot reconciliation and safe backup maintenance before the catch-up backup and timers', async () => {
    const order: string[] = [];
    const hooks = new ArchiveSchedulerHooksService();
    hooks.registerCamera({
      reconcileMotion: async () => { order.push('motion-reconcile'); },
      cleanupLocal: async () => undefined,
    });
    hooks.registerRemoteMaintenance(async () => { order.push('remote-reconcile'); });
    const lifecycle = new ArchiveRuntimeLifecycleService(
      {
        expireStaged: vi.fn(async () => { order.push('expire-staged'); return []; }),
        listInterruptedMaintenance: vi.fn(async () => []),
      },
      {
        recoverExpiredLeases: vi.fn(async () => { order.push('recover-leases'); return 0; }),
        listUnverifiedArtifactPaths: vi.fn(async () => ['/pinned.db']),
      } as unknown as ArchiveArtifactRepositoryPort,
      { execute: vi.fn() },
      { cancelAll: vi.fn() },
      {
        removeStaleTemporarySnapshots: vi.fn(async (input: { referencedPaths: ReadonlySet<string> }) => {
          expect([...input.referencedPaths]).toEqual(['/pinned.db']);
          order.push('stale-temp');
          return 1;
        }),
      },
      { execute: vi.fn(async () => { order.push('catch-up'); return { created: true, reason: 'catchup' }; }) } as unknown as CreateDatabaseBackupUseCase,
      {
        startTimers: vi.fn(() => { order.push('schedule'); }), shutdown: vi.fn(async () => undefined),
      },
      hooks,
      { now: () => new Date(1_000) },
    );

    await lifecycle.start();

    expect(order).toEqual([
      'expire-staged', 'recover-leases', 'motion-reconcile', 'remote-reconcile',
      'stale-temp', 'catch-up', 'schedule',
    ]);
  });

  it('cancels polling and aborts HTTP before scheduler recovery transitions finish', async () => {
    const order: string[] = [];
    const scheduler = {
      startTimers: vi.fn(),
      shutdown: vi.fn(async () => { order.push('scheduler-shutdown'); }),
    } as unknown as ArchiveSchedulerService;
    const polling = { cancelAll: vi.fn(() => { order.push('cancel-polling'); }) } as unknown as DriveAuthorizationPollingService;
    const lifecycle = new ArchiveRuntimeLifecycleService(
      { expireStaged: vi.fn(), listInterruptedMaintenance: vi.fn() },
      { recoverExpiredLeases: vi.fn(), listUnverifiedArtifactPaths: vi.fn() } as unknown as ArchiveArtifactRepositoryPort,
      { execute: vi.fn() },
      polling,
      { removeStaleTemporarySnapshots: vi.fn() },
      { execute: vi.fn() },
      scheduler,
      new ArchiveSchedulerHooksService(),
      { now: () => new Date(1_000) },
    );

    await lifecycle.shutdown();

    expect(order).toEqual(['cancel-polling', 'scheduler-shutdown']);
    expect(lifecycle.signal.aborted).toBe(true);
  });

  it('awaits cancelled boot maintenance and fences later recovery work', async () => {
    let maintenanceStarted!: () => void;
    const started = new Promise<void>((resolve) => { maintenanceStarted = resolve; });
    let maintenanceSettled = false;
    const hooks = new ArchiveSchedulerHooksService();
    hooks.registerCamera({
      reconcileMotion: async (signal) => {
        maintenanceStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            maintenanceSettled = true;
            resolve();
          }, { once: true });
        });
      },
      cleanupLocal: async () => undefined,
    });
    const backups = { execute: vi.fn() };
    const scheduler = { startTimers: vi.fn(), shutdown: vi.fn(async () => undefined) };
    const lifecycle = new ArchiveRuntimeLifecycleService(
      { expireStaged: vi.fn(async () => []), listInterruptedMaintenance: vi.fn(async () => []) },
      {
        recoverExpiredLeases: vi.fn(async () => 0),
        listUnverifiedArtifactPaths: vi.fn(async () => []),
      } as unknown as ArchiveArtifactRepositoryPort,
      { execute: vi.fn() },
      { cancelAll: vi.fn() },
      { removeStaleTemporarySnapshots: vi.fn() },
      backups,
      scheduler,
      hooks,
      { now: () => new Date(1_000) },
    );

    const boot = lifecycle.start();
    await started;
    await lifecycle.shutdown();
    await boot;

    expect(maintenanceSettled).toBe(true);
    expect(backups.execute).not.toHaveBeenCalled();
    expect(scheduler.startTimers).not.toHaveBeenCalled();
    expect(scheduler.shutdown).toHaveBeenCalledOnce();
  });

  interface BootOverrides {
    expireStaged?: () => Promise<readonly string[]>;
    recoverExpiredLeases?: () => Promise<number>;
    listUnverifiedArtifactPaths?: () => Promise<readonly string[]>;
    removeStaleTemporarySnapshots?: () => Promise<number>;
    backup?: () => Promise<{ created: boolean; reason: string }>;
    reconcileMotion?: (signal: AbortSignal) => Promise<void>;
    remoteMaintenance?: () => Promise<void>;
  }

  function bootFixture(overrides: BootOverrides = {}) {
    const hooks = new ArchiveSchedulerHooksService();
    hooks.registerCamera({
      reconcileMotion: overrides.reconcileMotion ?? (async () => undefined),
      cleanupLocal: async () => undefined,
    });
    hooks.registerRemoteMaintenance(overrides.remoteMaintenance ?? (async () => undefined));
    const wake = new ArchiveWakeService();
    const wakeSpy = vi.spyOn(wake, 'wake');
    const scheduler = { startTimers: vi.fn(), shutdown: vi.fn(async () => undefined) };
    const snapshots = {
      removeStaleTemporarySnapshots: vi.fn(overrides.removeStaleTemporarySnapshots ?? (async () => 0)),
    };
    const backups = {
      execute: vi.fn(overrides.backup ?? (async () => ({ created: false, reason: 'not_due' }))),
    } as unknown as CreateDatabaseBackupUseCase;
    const lifecycle = new ArchiveRuntimeLifecycleService(
      {
        expireStaged: vi.fn(overrides.expireStaged ?? (async () => [])),
        listInterruptedMaintenance: vi.fn(async () => []),
      },
      {
        recoverExpiredLeases: vi.fn(overrides.recoverExpiredLeases ?? (async () => 0)),
        listUnverifiedArtifactPaths: vi.fn(overrides.listUnverifiedArtifactPaths ?? (async () => [])),
      } as unknown as ArchiveArtifactRepositoryPort,
      { execute: vi.fn() },
      { cancelAll: vi.fn() },
      snapshots,
      backups,
      scheduler,
      hooks,
      { now: () => new Date(1_000) },
      undefined,
      wake,
    );
    const logger = (lifecycle as unknown as {
      logger: { warn: (message: string) => void; error: (message: string) => void };
    }).logger;
    return {
      lifecycle,
      scheduler,
      snapshots,
      backups,
      wakeSpy,
      warn: vi.spyOn(logger, 'warn').mockImplementation(() => undefined),
      error: vi.spyOn(logger, 'error').mockImplementation(() => undefined),
    };
  }

  it('starts scheduling when boot Motion reconciliation fails', async () => {
    const fixture = bootFixture({
      reconcileMotion: async () => { throw new Error('EACCES: /home/pi/motion/videos'); },
    });

    await expect(fixture.lifecycle.start()).resolves.toBeUndefined();

    expect(fixture.snapshots.removeStaleTemporarySnapshots).toHaveBeenCalledOnce();
    expect(fixture.backups.execute).toHaveBeenCalledOnce();
    expect(fixture.scheduler.startTimers).toHaveBeenCalledOnce();
    expect(fixture.wakeSpy).toHaveBeenCalledOnce();
    expect(fixture.warn).toHaveBeenCalledWith('Motion reconciliation failed: ARCHIVE_OPERATION_FAILED');
    expect(fixture.warn.mock.calls.flat().join(' ')).not.toContain('/home/pi');
  });

  it('starts scheduling when boot remote maintenance fails', async () => {
    const fixture = bootFixture({
      remoteMaintenance: async () => { throw new Error('drive unreachable'); },
    });

    await fixture.lifecycle.start();

    expect(fixture.backups.execute).toHaveBeenCalledOnce();
    expect(fixture.scheduler.startTimers).toHaveBeenCalledOnce();
    expect(fixture.wakeSpy).toHaveBeenCalledOnce();
    expect(fixture.warn).toHaveBeenCalledWith('remote maintenance failed: ARCHIVE_OPERATION_FAILED');
  });

  it('starts scheduling when stale snapshot cleanup fails', async () => {
    const fixture = bootFixture({
      removeStaleTemporarySnapshots: async () => { throw new Error('EIO'); },
    });

    await fixture.lifecycle.start();

    expect(fixture.backups.execute).toHaveBeenCalledOnce();
    expect(fixture.scheduler.startTimers).toHaveBeenCalledOnce();
    expect(fixture.warn).toHaveBeenCalledWith('stale snapshot cleanup failed: ARCHIVE_OPERATION_FAILED');
  });

  it('skips snapshot pruning but keeps scheduling when the referenced path lookup fails', async () => {
    const fixture = bootFixture({
      listUnverifiedArtifactPaths: async () => { throw new Error('EIO'); },
    });

    await fixture.lifecycle.start();

    expect(fixture.snapshots.removeStaleTemporarySnapshots).not.toHaveBeenCalled();
    expect(fixture.backups.execute).toHaveBeenCalledOnce();
    expect(fixture.scheduler.startTimers).toHaveBeenCalledOnce();
    expect(fixture.warn).toHaveBeenCalledWith('stale snapshot cleanup failed: ARCHIVE_OPERATION_FAILED');
  });

  it('starts scheduling when the boot catch-up backup fails', async () => {
    const fixture = bootFixture({
      backup: async () => { throw new Error('sqlite is locked'); },
    });

    await fixture.lifecycle.start();

    expect(fixture.scheduler.startTimers).toHaveBeenCalledOnce();
    expect(fixture.wakeSpy).toHaveBeenCalledOnce();
    expect(fixture.warn).toHaveBeenCalledWith('database backup failed: ARCHIVE_OPERATION_FAILED');
  });

  it('fails boot recovery when expiring staged credentials fails', async () => {
    const fixture = bootFixture({
      expireStaged: async () => { throw new Error('database is locked'); },
    });

    await expect(fixture.lifecycle.start()).rejects.toThrow('database is locked');

    expect(fixture.scheduler.startTimers).not.toHaveBeenCalled();
    expect(fixture.wakeSpy).not.toHaveBeenCalled();
  });

  it('fails boot recovery when expired lease recovery fails', async () => {
    const fixture = bootFixture({
      recoverExpiredLeases: async () => { throw new Error('database is locked'); },
    });

    await expect(fixture.lifecycle.start()).rejects.toThrow('database is locked');

    expect(fixture.backups.execute).not.toHaveBeenCalled();
    expect(fixture.scheduler.startTimers).not.toHaveBeenCalled();
  });

  it('keeps the application bootstrap hook alive when boot recovery fails', async () => {
    const fixture = bootFixture({
      expireStaged: async () => { throw new Error('database is locked'); },
    });

    await expect(fixture.lifecycle.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(fixture.lifecycle.start()).rejects.toThrow('database is locked');

    expect(fixture.error).toHaveBeenCalledWith('Archive boot recovery failed: ARCHIVE_OPERATION_FAILED');
    expect(fixture.error.mock.calls.flat().join(' ')).not.toContain('database is locked');
  });

  it('fences later boot recovery work when a contained step throws during shutdown', async () => {
    let reconcileStarted!: () => void;
    const started = new Promise<void>((resolve) => { reconcileStarted = resolve; });
    const fixture = bootFixture({
      reconcileMotion: async (signal) => {
        reconcileStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('motion scan aborted');
      },
    });

    const boot = fixture.lifecycle.start();
    await started;
    await fixture.lifecycle.shutdown();
    await boot;

    expect(fixture.backups.execute).not.toHaveBeenCalled();
    expect(fixture.scheduler.startTimers).not.toHaveBeenCalled();
    expect(fixture.warn).not.toHaveBeenCalled();
  });

  it('names the failing error code when the bootstrap hook swallows a boot failure', async () => {
    const fixture = bootFixture({
      expireStaged: async () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); },
    });

    await fixture.lifecycle.onApplicationBootstrap();

    expect(fixture.error).toHaveBeenCalledWith('Archive boot recovery failed: SQLITE_BUSY');
  });

  it('names the error class when the boot failure carries no code', async () => {
    class DriveTemporaryUnavailableError extends Error {
      override readonly name = 'DriveTemporaryUnavailableError';
    }
    const fixture = bootFixture({
      recoverExpiredLeases: async () => { throw new DriveTemporaryUnavailableError('drive is gone'); },
    });

    await fixture.lifecycle.onApplicationBootstrap();

    expect(fixture.error).toHaveBeenCalledWith(
      'Archive boot recovery failed: DriveTemporaryUnavailableError',
    );
  });

  it('falls back to the fixed code when a boot failure code could carry a path', async () => {
    const fixture = bootFixture({
      expireStaged: async () => {
        throw Object.assign(new Error('open failed'), { code: 'EACCES: /home/pi/motion/videos' });
      },
    });

    await fixture.lifecycle.onApplicationBootstrap();

    expect(fixture.error).toHaveBeenCalledWith('Archive boot recovery failed: ARCHIVE_OPERATION_FAILED');
    expect(fixture.error.mock.calls.flat().join(' ')).not.toContain('/home/pi');
  });

  it('stops at the fence after Motion reconciliation when shutdown races it', async () => {
    let abort = (): void => undefined;
    const remoteMaintenance = vi.fn(async () => undefined);
    const fixture = bootFixture({
      remoteMaintenance,
      reconcileMotion: async () => {
        abort();
        throw new Error('motion scan aborted');
      },
    });
    abort = () => { void fixture.lifecycle.shutdown(); };

    await fixture.lifecycle.start();

    expect(remoteMaintenance).not.toHaveBeenCalled();
    expect(fixture.scheduler.startTimers).not.toHaveBeenCalled();
  });

  it('stops at the fence after remote maintenance when shutdown races it', async () => {
    let abort = (): void => undefined;
    const fixture = bootFixture({
      remoteMaintenance: async () => {
        abort();
        throw new Error('drive unreachable');
      },
    });
    abort = () => { void fixture.lifecycle.shutdown(); };

    await fixture.lifecycle.start();

    expect(fixture.snapshots.removeStaleTemporarySnapshots).not.toHaveBeenCalled();
    expect(fixture.scheduler.startTimers).not.toHaveBeenCalled();
  });

  it('stops at the fence after stale snapshot cleanup when shutdown races it', async () => {
    let abort = (): void => undefined;
    const fixture = bootFixture({
      removeStaleTemporarySnapshots: async () => {
        abort();
        throw new Error('EIO');
      },
    });
    abort = () => { void fixture.lifecycle.shutdown(); };

    await fixture.lifecycle.start();

    expect(fixture.backups.execute).not.toHaveBeenCalled();
    expect(fixture.scheduler.startTimers).not.toHaveBeenCalled();
  });

  it('stops at the fence after the catch-up backup when shutdown races it', async () => {
    let abort = (): void => undefined;
    const fixture = bootFixture({
      backup: async () => {
        abort();
        throw new Error('sqlite is locked');
      },
    });
    abort = () => { void fixture.lifecycle.shutdown(); };

    await fixture.lifecycle.start();

    expect(fixture.scheduler.startTimers).not.toHaveBeenCalled();
    expect(fixture.wakeSpy).not.toHaveBeenCalled();
  });
});

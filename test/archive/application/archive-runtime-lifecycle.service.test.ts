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

function connection(status: 'retiring' | 'disconnecting'): DriveConnection {
  return DriveConnection.restore({
    id: status, installationId: 'installation-1', status, revision: 1,
    permissionId: 'permission-1', email: null, displayName: null,
    folders: { rootId: 'root', motionId: 'motion', backupsId: 'backups' },
    createdAtMs: 1, updatedAtMs: 2, activatedAtMs: 1, retiredAtMs: null,
  });
}

describe('ArchiveRuntimeLifecycleService', () => {
  it('recovers retiring and disconnecting generations before normal scheduling', async () => {
    const order: string[] = [];
    const credentials = {
      expireStaged: vi.fn(async () => { order.push('expire-staged'); return []; }),
      listInterruptedMaintenance: vi.fn(async () => [connection('disconnecting'), connection('retiring')]),
    } as unknown as DriveCredentialRepositoryPort;
    const repository = {
      releaseGenerationLeases: vi.fn(async () => undefined),
      clearGenerationSessions: vi.fn(async () => undefined),
      recoverExpiredLeases: vi.fn(async () => { order.push('recover-leases'); return 0; }),
      listUnverifiedArtifactPaths: vi.fn(async () => []),
    } as unknown as ArchiveArtifactRepositoryPort;
    const retire = {
      execute: vi.fn(async (candidate: DriveConnection) => { order.push(candidate.status === 'retiring' ? 'retire' : 'disconnect'); }),
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

    expect(order).toEqual(['expire-staged', 'retire', 'disconnect', 'recover-leases', 'schedule']);
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
});

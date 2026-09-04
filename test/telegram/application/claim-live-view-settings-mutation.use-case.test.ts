import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { ClaimLiveViewSettingsMutationUseCase } from '../../../src/telegram/application/claim-live-view-settings-mutation.use-case';
import { LiveViewSettingsBusyError } from '../../../src/camera/domain/errors/live-view-settings-busy.error';
import { LiveViewSettingsStateError } from '../../../src/camera/domain/errors/live-view-settings-state.error';
import type { LiveViewSettingsDocument } from '../../../src/camera/domain/live-view-settings';
import type { LiveViewSettingsStorePort } from '../../../src/camera/domain/ports/live-view-settings-store.port';
import { InMemoryLiveViewSettingsJobRepository } from '../../../src/camera/infrastructure/in-memory-live-view-settings-job.repository';
import type { AppDatabase } from '../../../src/database/database.module';
import { homeActionReceipts, liveViewSettingsJobs, users } from '../../../src/database/schema';
import type { Feature } from '../../../src/features/domain/feature.entity';
import { InMemoryFeatureInstallJobRepository } from '../../../src/features/infrastructure/in-memory-feature-install-job.repository';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { DrizzleHomeActionRepository } from '../../../src/telegram/infrastructure/drizzle-home-action.repository';
import { InMemoryHomeActionRepository } from '../../../src/telegram/infrastructure/in-memory-home-action.repository';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';

const now = new Date('2030-01-01T00:00:00.000Z');
const clock = { now: () => now };
const candidate = { enabled: true, allowedCameraCidrs: ['192.168.1.0/24'] } as const;

describe('ClaimLiveViewSettingsMutationUseCase', () => {
  it('fresh-reads committed settings before atomically claiming role, receipt, and job', async () => {
    const test = setup();
    let reads = 0;
    const originalClaim = test.actions.claimLiveViewSettingsMutation.bind(test.actions);
    test.actions.claimLiveViewSettingsMutation = async (input) => {
      expect(reads).toBe(1);
      return originalClaim(input);
    };
    const settings: LiveViewSettingsStorePort = {
      ...test.settings,
      readCommitted: async () => { reads += 1; return test.settings.readCommitted(); },
    };
    const claim = new ClaimLiveViewSettingsMutationUseCase(test.actions, settings, clock);

    await expect(claim.execute({
      userId: 1001,
      chatId: 1001,
      receiptId: test.receipt.id,
      jobId: 'AbCdEfGhIjKlMnOp',
      expectedGeneration: 3,
      candidate,
    })).resolves.toMatchObject({
      id: 'AbCdEfGhIjKlMnOp',
      status: 'prepared',
      activeSlot: 1,
      expectedGeneration: 3,
      candidateSettings: candidate,
    });
    await expect(test.jobs.findActive()).resolves.toMatchObject({ id: 'AbCdEfGhIjKlMnOp' });
    await expect(test.actions.findWorkflowReturnExact({
      userId: 1001, chatId: 1001, id: test.receipt.id, now,
    })).resolves.toMatchObject({
      status: 'executing',
      payload: {
        workflow: 'live-view-settings',
        phase: 'running',
        operation: {
          kind: 'live-view-settings-mutation',
          jobId: 'AbCdEfGhIjKlMnOp',
          expectedGeneration: 3,
        },
      },
    });
  });

  it('rejects a second administrator while preserving the first active job', async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    const users = usersFor(1001, 2002);
    const actions = new InMemoryHomeActionRepository(users, undefined, jobs);
    await actions.beginWorkflowReturn(receipt(1001, 'QrStUvWxYz012345', 'AbCdEfGhIjKlMnOp'));
    await actions.beginWorkflowReturn(receipt(2002, 'ZaYbXcWdVeUfTgSh', 'BcDeFgHiJkLmNoPq'));
    const claim = new ClaimLiveViewSettingsMutationUseCase(actions, settingsAt(3), clock);

    await claim.execute({
      userId: 1001, chatId: 1001, receiptId: 'QrStUvWxYz012345',
      jobId: 'AbCdEfGhIjKlMnOp', expectedGeneration: 3, candidate,
    });
    await expect(claim.execute({
      userId: 2002, chatId: 2002, receiptId: 'ZaYbXcWdVeUfTgSh',
      jobId: 'BcDeFgHiJkLmNoPq', expectedGeneration: 3, candidate,
    })).rejects.toBeInstanceOf(LiveViewSettingsBusyError);

    await expect(jobs.findActive()).resolves.toMatchObject({ id: 'AbCdEfGhIjKlMnOp' });
    await expect(actions.findWorkflowReturnExact({
      userId: 2002, chatId: 2002, id: 'ZaYbXcWdVeUfTgSh', now,
    })).resolves.toMatchObject({ status: 'pending', payload: { phase: 'cancellable' } });
  });

  it('atomically persists the Drizzle receipt transition, durable routing, and global slot', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      const db: AppDatabase = drizzle(sqlite);
      migrate(db, { migrationsFolder: 'migrations' });
      db.insert(users).values([
        { telegramId: 1001, name: 'First', role: 'admin' },
        { telegramId: 2002, name: 'Second', role: 'admin' },
      ]).run();
      const actions = new DrizzleHomeActionRepository(db);
      await actions.beginWorkflowReturn(receipt(1001, 'QrStUvWxYz012345', 'AbCdEfGhIjKlMnOp'));
      await actions.beginWorkflowReturn(receipt(2002, 'ZaYbXcWdVeUfTgSh', 'BcDeFgHiJkLmNoPq'));
      const claim = new ClaimLiveViewSettingsMutationUseCase(actions, settingsAt(3), clock);

      await claim.execute({
        userId: 1001, chatId: 1001, receiptId: 'QrStUvWxYz012345',
        jobId: 'AbCdEfGhIjKlMnOp', expectedGeneration: 3, candidate,
      });
      await expect(claim.execute({
        userId: 2002, chatId: 2002, receiptId: 'ZaYbXcWdVeUfTgSh',
        jobId: 'BcDeFgHiJkLmNoPq', expectedGeneration: 3, candidate,
      })).rejects.toBeInstanceOf(LiveViewSettingsBusyError);

      expect(db.select().from(liveViewSettingsJobs).all()).toEqual([
        expect.objectContaining({
          id: 'AbCdEfGhIjKlMnOp',
          activeSlot: 1,
          requestedByUserId: 1001,
          requestedInChatId: 1001,
          workflowReceiptId: 'QrStUvWxYz012345',
          candidateSettings: candidate,
        }),
      ]);
      expect(db.select().from(homeActionReceipts).where(and(
        eq(homeActionReceipts.userId, 2002),
        eq(homeActionReceipts.id, 'ZaYbXcWdVeUfTgSh'),
      )).get()).toMatchObject({ status: 'pending' });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['demoted user', (test: TestContext) => test.users.updateRole(1001, 'user')],
    ['expired receipt', async (test: TestContext) => {
      await test.actions.beginWorkflowReturn({ ...test.receipt, expiresAt: now });
    }],
    ['mismatched workflow', async (test: TestContext) => {
      await test.actions.beginWorkflowReturn({
        ...test.receipt,
        payload: {
          workflow: 'logs', phase: 'cancellable', originSource: 'natural-parent',
          origin: { kind: 'home', checking: false }, deliveryStage: 'pending',
        },
      });
    }],
    ['mismatched operation', async (test: TestContext) => {
      await test.actions.beginWorkflowReturn(receipt(1001, test.receipt.id, 'BcDeFgHiJkLmNoPq'));
    }],
  ] as const)('leaves receipt and jobs unchanged for a %s', async (_name, arrange) => {
    const test = setup();
    await arrange(test);
    const before = await test.actions.findWorkflowReturnExact({
      userId: 1001, chatId: 1001, id: test.receipt.id, now: new Date(now.getTime() - 1),
    });
    const claim = new ClaimLiveViewSettingsMutationUseCase(test.actions, test.settings, clock);

    await expect(claim.execute({
      userId: 1001, chatId: 1001, receiptId: test.receipt.id,
      jobId: 'AbCdEfGhIjKlMnOp', expectedGeneration: 3, candidate,
    })).rejects.toBeInstanceOf(LiveViewSettingsStateError);

    await expect(test.jobs.findActive()).resolves.toBeNull();
    await expect(test.actions.findWorkflowReturnExact({
      userId: 1001, chatId: 1001, id: test.receipt.id, now: new Date(now.getTime() - 1),
    })).resolves.toEqual(before);
  });

  it('rejects a stale generation before opening the claim transaction', async () => {
    const test = setup();
    const claim = new ClaimLiveViewSettingsMutationUseCase(test.actions, settingsAt(4), clock);

    await expect(claim.execute({
      userId: 1001, chatId: 1001, receiptId: test.receipt.id,
      jobId: 'AbCdEfGhIjKlMnOp', expectedGeneration: 3, candidate,
    })).rejects.toBeInstanceOf(LiveViewSettingsStateError);
    await expect(test.jobs.findActive()).resolves.toBeNull();
    await expect(test.actions.findWorkflowReturnExact({
      userId: 1001, chatId: 1001, id: test.receipt.id, now,
    })).resolves.toMatchObject({ status: 'pending', payload: { phase: 'cancellable' } });
  });

  it('rejects an active RTSP install without changing the receipt or settings jobs', async () => {
    const features = new InMemoryFeatureRepository([{
      name: 'rtsp', installed: false, enabled: false, config: null, attentionReason: null,
    } satisfies Feature]);
    const featureJobs = new InMemoryFeatureInstallJobRepository(features);
    await featureJobs.createQueued({
      id: 'RtSpInStAlL01234',
      feature: 'rtsp',
      operation: 'install',
      requestedByUserId: 1001,
      requestedInChatId: 1001,
      workflowReceiptId: 'FtRtSpRcPt012345',
      expected: { installed: false, enabled: false },
      now,
    });
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    const users = usersFor(1001);
    const actions = new InMemoryHomeActionRepository(users, featureJobs, jobs);
    const workflowReceipt = receipt(1001, 'QrStUvWxYz012345', 'AbCdEfGhIjKlMnOp');
    await actions.beginWorkflowReturn(workflowReceipt);
    const claim = new ClaimLiveViewSettingsMutationUseCase(actions, settingsAt(3), clock);

    await expect(claim.execute({
      userId: 1001, chatId: 1001, receiptId: workflowReceipt.id,
      jobId: 'AbCdEfGhIjKlMnOp', expectedGeneration: 3, candidate,
    })).rejects.toBeInstanceOf(LiveViewSettingsBusyError);
    await expect(jobs.findActive()).resolves.toBeNull();
    await expect(actions.findWorkflowReturnExact({
      userId: 1001, chatId: 1001, id: workflowReceipt.id, now,
    })).resolves.toMatchObject({ status: 'pending' });
  });
});

interface TestContext {
  users: InMemoryUserRepository;
  actions: InMemoryHomeActionRepository;
  jobs: InMemoryLiveViewSettingsJobRepository;
  receipt: WorkflowReturnReceipt;
  settings: LiveViewSettingsStorePort;
}

function setup(): TestContext {
  const jobs = new InMemoryLiveViewSettingsJobRepository();
  const users = usersFor(1001);
  const actions = new InMemoryHomeActionRepository(users, undefined, jobs);
  const workflowReceipt = receipt(1001, 'QrStUvWxYz012345', 'AbCdEfGhIjKlMnOp');
  void actions.beginWorkflowReturn(workflowReceipt);
  return { users, actions, jobs, receipt: workflowReceipt, settings: settingsAt(3) };
}

function usersFor(...ids: number[]): InMemoryUserRepository {
  return new InMemoryUserRepository(ids.map((telegramId) => ({
    telegramId,
    name: 'Admin',
    role: 'admin' as const,
    locale: 'en' as const,
    muted: false,
    nonCriticalPausedUntil: null,
    notificationPauseRevision: 0,
    quietStart: null,
    quietEnd: null,
    createdAt: now,
  })));
}

function receipt(userId: number, id: string, jobId: string): WorkflowReturnReceipt {
  return {
    id,
    userId,
    chatId: userId,
    kind: 'workflow-return',
    sessionToken: null,
    status: 'pending',
    expiresAt: new Date(now.getTime() + 60_000),
    payload: {
      workflow: 'live-view-settings',
      phase: 'cancellable',
      originSource: 'natural-parent',
      origin: { kind: 'home', checking: false },
      operation: { kind: 'live-view-settings-mutation', jobId, expectedGeneration: 3 },
      deliveryStage: 'pending',
    },
  };
}

function settingsAt(generation: number): LiveViewSettingsStorePort {
  const committed: LiveViewSettingsDocument = {
    version: 1,
    generation,
    enabled: false,
    allowedCameraCidrs: [],
  };
  return {
    readCommitted: async () => committed,
    bootLoadedGeneration: () => generation,
    simulateDevelopmentRestart: async () => undefined,
  };
}

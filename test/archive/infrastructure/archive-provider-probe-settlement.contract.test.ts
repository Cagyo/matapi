import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import type {
  ArchiveAdminAlertOutboxPort,
  ArchiveProviderProbeFailureSettlementInput,
} from '../../../src/archive/application/ports/archive-admin-alert-outbox.port';
import type { ArchiveProviderStateRepositoryPort } from '../../../src/archive/application/ports/archive-provider-state-repository.port';
import { DrizzleArchiveAdminAlertOutboxAdapter } from '../../../src/archive/infrastructure/events/drizzle-archive-admin-alert-outbox.adapter';
import { SharedStateArchiveAdminAlertOutboxAdapter } from '../../../src/archive/infrastructure/events/shared-state-archive-admin-alert-outbox.adapter';
import { DrizzleArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/drizzle-archive-provider-state.repository';
import { InMemoryArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-provider-state.repository';
import { InMemoryDriveCredentialRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-credential.repository';
import { InMemoryEventRepository } from '../../../src/events/infrastructure/in-memory-event.repository';
import type { NewQueuedEvent, QueuedEvent } from '../../../src/events/domain/queued-event.entity';

interface ProbeSettlementHarness {
  settlement: ArchiveAdminAlertOutboxPort;
  providerState: ArchiveProviderStateRepositoryPort;
  input: ArchiveProviderProbeFailureSettlementInput;
  readAlertCooldowns(): Promise<Readonly<Record<string, number>>>;
  unsent(): Promise<readonly QueuedEvent[]>;
  seedUnsent(): Promise<void>;
  failNextEnqueue(): void;
  close(): void;
}

const adapters = [
  ['Drizzle', createDrizzleHarness],
  ['shared state', createSharedStateHarness],
] as const;

describe.each(adapters)('%s archive provider probe settlement', (_name, createHarness) => {
  it('reinstates the classified block and alert cooldown as one settlement', async () => {
    const harness = await createHarness();
    try {
      await expect(harness.settlement.settleProviderProbeFailure(harness.input))
        .resolves.toBe('settled');

      await expect(harness.providerState.load()).resolves.toMatchObject({
        blockReason: 'policy_blocked',
        operationClass: 'upload',
        revision: harness.input.expectedProviderRevision + 1,
      });
      await expect(harness.readAlertCooldowns()).resolves.toMatchObject({
        'policy-rejected': harness.input.alertCooldownUntilMs,
      });
      await expect(harness.unsent()).resolves.toMatchObject([
        { type: 'archive_admin_alert', payload: { kind: 'policy-rejected' } },
      ]);
    } finally {
      harness.close();
    }
  });

  it.each(['provider revision', 'active connection'] as const)(
    'changes nothing when the %s fence is stale',
    async (staleFence) => {
      const harness = await createHarness();
      try {
        const before = await snapshot(harness);
        const stale = staleFence === 'provider revision'
          ? {
            ...harness.input,
            expectedProviderRevision: harness.input.expectedProviderRevision - 1,
          }
          : {
            ...harness.input,
            fence: { ...harness.input.fence, revision: harness.input.fence.revision - 1 },
          };

        await expect(harness.settlement.settleProviderProbeFailure(stale))
          .resolves.toBe('lost');
        await expect(snapshot(harness)).resolves.toEqual(before);
      } finally {
        harness.close();
      }
    },
  );

  it('changes nothing when the failed probe operation class is stale', async () => {
    const harness = await createHarness();
    try {
      const before = await snapshot(harness);
      await expect(harness.settlement.settleProviderProbeFailure({
        ...harness.input,
        nextProviderState: {
          ...harness.input.nextProviderState,
          operationClass: 'folder',
        },
      })).resolves.toBe('lost');
      await expect(snapshot(harness)).resolves.toEqual(before);
    } finally {
      harness.close();
    }
  });

  it('rolls provider state and alert cooldown back when bounded enqueue fails', async () => {
    const harness = await createHarness();
    try {
      const before = await snapshot(harness);
      harness.failNextEnqueue();

      await expect(harness.settlement.settleProviderProbeFailure(harness.input))
        .rejects.toThrow('injected probe alert enqueue failure');
      await expect(snapshot(harness)).resolves.toEqual(before);
    } finally {
      harness.close();
    }
  });

  it('settles at most one concurrent caller for the same claimed revision', async () => {
    const harness = await createHarness();
    try {
      const results = await Promise.all([
        harness.settlement.settleProviderProbeFailure(harness.input),
        harness.settlement.settleProviderProbeFailure(harness.input),
        harness.settlement.settleProviderProbeFailure(harness.input),
      ]);

      expect(results.filter((result) => result === 'settled')).toHaveLength(1);
      expect(results.filter((result) => result === 'lost')).toHaveLength(2);
      await expect(harness.unsent()).resolves.toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it('retains a live alert cooldown while still reinstating provider state', async () => {
    const harness = await createHarness();
    try {
      await harness.settlement.enqueue({
        fence: harness.input.fence,
        kind: harness.input.alertKind,
        nowMs: 500,
        cooldownUntilMs: harness.input.alertCooldownUntilMs + 10_000,
      });

      await expect(harness.settlement.settleProviderProbeFailure(harness.input))
        .resolves.toBe('settled');
      await expect(harness.readAlertCooldowns()).resolves.toMatchObject({
        'policy-rejected': harness.input.alertCooldownUntilMs + 10_000,
      });
      await expect(harness.unsent()).resolves.toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it('uses the existing bounded queue eviction rule for a probe alert', async () => {
    const harness = await createHarness();
    try {
      await harness.seedUnsent();

      await expect(harness.settlement.settleProviderProbeFailure(harness.input))
        .resolves.toBe('settled');
      await expect(harness.unsent()).resolves.toMatchObject([
        { type: 'archive_admin_alert', payload: { kind: 'policy-rejected' } },
      ]);
    } finally {
      harness.close();
    }
  });
});

async function createDrizzleHarness(): Promise<ProbeSettlementHarness> {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './migrations' });
  const providerState = new DrizzleArchiveProviderStateRepository(db);
  const input = await seedClaimedPolicyProbe(providerState);
  db.insert(schema.driveConnections).values({
    id: input.fence.id,
    installationId: 'installation-1',
    status: input.fence.status,
    revision: input.fence.revision,
    clientIdHash: 'hash-1',
    currentSlot: 1,
    createdAt: 1,
    updatedAt: 1,
    alertCooldowns: {},
  }).run();
  const settlement = new DrizzleArchiveAdminAlertOutboxAdapter(db, { maxUnsentEvents: 1 });
  let triggerInstalled = false;

  return {
    settlement,
    providerState,
    input,
    async readAlertCooldowns() {
      const row = db.select({ cooldowns: schema.driveConnections.alertCooldowns })
        .from(schema.driveConnections).get();
      return asCooldowns(row?.cooldowns);
    },
    async unsent() {
      return db.select().from(schema.events).all().map((event) => ({
        id: event.id,
        sensorId: event.sensorId,
        type: event.type,
        payload: event.payload as Record<string, unknown> | null,
        createdAt: event.createdAt,
      }));
    },
    async seedUnsent() {
      db.insert(schema.events).values({
        sensorId: null,
        type: 'old_event',
        payload: null,
        createdAt: new Date(0),
      }).run();
    },
    failNextEnqueue() {
      sqlite.exec(`
        CREATE TRIGGER reject_provider_probe_alert
        BEFORE INSERT ON events
        WHEN NEW.type = 'archive_admin_alert'
        BEGIN
          SELECT RAISE(FAIL, 'injected probe alert enqueue failure');
        END;
      `);
      triggerInstalled = true;
    },
    close() {
      if (triggerInstalled) sqlite.exec('DROP TRIGGER reject_provider_probe_alert');
      sqlite.close();
    },
  };
}

async function createSharedStateHarness(): Promise<ProbeSettlementHarness> {
  const credentials = new InMemoryDriveCredentialRepository();
  const staged = await credentials.stage({
    id: 'generation-1',
    installationId: 'installation-1',
    client: { clientId: 'client', clientSecret: 'secret' },
    clientIdHash: 'hash-1',
    adminUserId: 1,
    chatId: 1,
    receiptId: 'receipt-1',
    createdAtMs: 1,
    expiresAtMs: 2,
  });
  const activated = await credentials.activate({
    stagedId: staged.id,
    expectedRevision: staged.revision,
    permissionId: 'owner-1',
    email: null,
    displayName: null,
    folders: { rootId: 'root', motionId: 'motion', backupsId: 'backups' },
    activatedAtMs: 2,
  });
  const providerState = new InMemoryArchiveProviderStateRepository();
  const input = await seedClaimedPolicyProbe(providerState, activated.active.revision);
  const storedEvents = new InMemoryEventRepository({ maxUnsentEvents: 1 });
  let rejectNext = false;
  const events = {
    async enqueue(event: NewQueuedEvent): Promise<QueuedEvent> {
      if (rejectNext) {
        rejectNext = false;
        throw new Error('injected probe alert enqueue failure');
      }
      return storedEvents.enqueue(event);
    },
  };
  const settlement = new SharedStateArchiveAdminAlertOutboxAdapter(
    credentials,
    events,
    providerState,
  );

  return {
    settlement,
    providerState,
    input,
    async readAlertCooldowns() {
      return asCooldowns(await credentials.readAlertCooldowns(input.fence.id));
    },
    unsent: () => storedEvents.pending(100),
    async seedUnsent() {
      await storedEvents.enqueue({
        sensorId: null,
        type: 'old_event',
        payload: null,
        createdAt: new Date(0),
      });
    },
    failNextEnqueue() {
      rejectNext = true;
    },
    close: () => undefined,
  };
}

async function seedClaimedPolicyProbe(
  providerState: ArchiveProviderStateRepositoryPort,
  connectionRevision = 1,
): Promise<ArchiveProviderProbeFailureSettlementInput> {
  const empty = await providerState.load();
  await providerState.activateGeneration(empty.revision, 'generation-1', 1);
  const active = await providerState.load();
  await providerState.compareAndSet(active.revision, {
    generationId: 'generation-1',
    operationClass: 'upload',
    failureClass: 'policy',
    failureStreak: 1,
    cooldownUntilMs: 61_000,
    blockReason: 'policy_blocked',
    updatedAtMs: 1_000,
  });
  const claimed = await providerState.load();
  return {
    fence: { id: 'generation-1', revision: connectionRevision, status: 'active' },
    expectedProviderRevision: claimed.revision,
    nextProviderState: {
      generationId: 'generation-1',
      operationClass: 'upload',
      failureClass: 'policy',
      failureStreak: 2,
      cooldownUntilMs: null,
      blockReason: 'policy_blocked',
      updatedAtMs: 1_000,
    },
    alertKind: 'policy-rejected',
    errorCode: 'DRIVE_POLICY_BLOCKED',
    nowMs: 1_000,
    alertCooldownUntilMs: 3_601_000,
  };
}

async function snapshot(harness: ProbeSettlementHarness) {
  return {
    provider: await harness.providerState.load(),
    cooldowns: await harness.readAlertCooldowns(),
    events: await harness.unsent(),
  };
}

function asCooldowns(value: unknown): Readonly<Record<string, number>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, number>
    : {};
}

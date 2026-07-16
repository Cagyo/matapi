import { describe, expect, it, vi } from 'vitest';
import type { ClockPort } from '../../../src/events/domain/ports/clock.port';
import type { SensorDashboardPage } from '../../../src/sensors/domain/sensor-dashboard-page';
import { BeginWorkflowReturnUseCase } from '../../../src/telegram/application/begin-workflow-return.use-case';
import { ClaimWorkflowReturnUseCase } from '../../../src/telegram/application/claim-workflow-return.use-case';
import { CompleteWorkflowReturnUseCase } from '../../../src/telegram/application/complete-workflow-return.use-case';
import { GetHomeScreenUseCase } from '../../../src/telegram/application/get-home-screen.use-case';
import { OpenHomeUseCase } from '../../../src/telegram/application/open-home.use-case';
import {
  naturalWorkflowOrigin,
  ResolveWorkflowOriginUseCase,
} from '../../../src/telegram/application/resolve-workflow-origin.use-case';
import { RestoreWorkflowOriginUseCase } from '../../../src/telegram/application/restore-workflow-origin.use-case';
import { UpdateWorkflowReturnUseCase } from '../../../src/telegram/application/update-workflow-return.use-case';
import type { HomeScreen } from '../../../src/telegram/application/home-screen';
import type { HomeView } from '../../../src/telegram/domain/home-session';
import type { ExternalWorkflow } from '../../../src/telegram/domain/workflow-return';
import { InMemoryHomeActionRepository } from '../../../src/telegram/infrastructure/in-memory-home-action.repository';
import { InMemoryHomeMessageDeliveryAdapter } from '../../../src/telegram/infrastructure/in-memory-home-message-delivery.adapter';
import { InMemoryHomeSessionStore } from '../../../src/telegram/infrastructure/in-memory-home-session.store';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const FIRST_ID = 'abcdefghijklmnop';
const SECOND_ID = 'qrstuvwxyzabcdef';
const SENSOR_ID = '00000000-0000-4000-8000-000000000001';
const MISSING_ID = '00000000-0000-4000-8000-000000000099';

function lifecycleSetup() {
  let now = NOW;
  const clock: ClockPort = { now: () => new Date(now) };
  const repository = new InMemoryHomeActionRepository();
  const ids = [FIRST_ID, SECOND_ID];
  return {
    repository,
    setNow(value: Date) { now = value; },
    begin: new BeginWorkflowReturnUseCase(repository, { generate: () => ids.shift() ?? SECOND_ID }, clock),
    update: new UpdateWorkflowReturnUseCase(repository, clock),
    claim: new ClaimWorkflowReturnUseCase(repository, clock),
    complete: new CompleteWorkflowReturnUseCase(repository, clock),
  };
}

function beginInput(overrides: Partial<Parameters<BeginWorkflowReturnUseCase['execute']>[0]> = {}) {
  return {
    userId: 7,
    chatId: 70,
    workflow: 'camera' as const,
    origin: { kind: 'home', checking: false } as HomeView,
    originSource: 'captured' as const,
    sessionToken: 'home-session-token',
    ...overrides,
  };
}

describe('workflow return receipt lifecycle use cases', () => {
  it('begins a cancellable receipt with an exact 24-hour TTL', async () => {
    const { begin, repository } = lifecycleSetup();

    const result = await begin.execute(beginInput());

    expect(result).toEqual({
      receipt: {
        id: FIRST_ID,
        userId: 7,
        chatId: 70,
        kind: 'workflow-return',
        sessionToken: 'home-session-token',
        status: 'pending',
        expiresAt: new Date('2030-01-02T00:00:00.000Z'),
        payload: {
          workflow: 'camera',
          phase: 'cancellable',
          originSource: 'captured',
          origin: { kind: 'home', checking: false },
        },
      },
      replaced: null,
    });
    await expect(repository.findWorkflowReturn({ userId: 7, chatId: 70, now: NOW }))
      .resolves.toEqual(result.receipt);
  });

  it('returns the replaced receipt and makes its exact ID unable to update, claim, or finish', async () => {
    const { begin, update, claim, complete } = lifecycleSetup();
    const first = await begin.execute(beginInput());
    const second = await begin.execute(beginInput({ workflow: 'help', originSource: 'natural-parent', origin: { kind: 'more' }, sessionToken: null }));

    expect(second.replaced).toEqual(first.receipt);
    await expect(update.execute({ userId: 7, chatId: 70, id: FIRST_ID, phase: 'running' }))
      .resolves.toBe('superseded');
    await expect(claim.execute({ userId: 7, chatId: 70, id: FIRST_ID }))
      .resolves.toEqual({ kind: 'superseded' });
    await expect(complete.execute({ userId: 7, chatId: 70, id: FIRST_ID, outcome: 'completed' }))
      .resolves.toBe('superseded');
  });

  it('refreshes the 24-hour TTL only through an exact-ID phase update', async () => {
    const { begin, update, repository, setNow } = lifecycleSetup();
    await begin.execute(beginInput());
    const later = new Date('2030-01-01T06:00:00.000Z');
    setNow(later);

    await expect(update.execute({ userId: 7, chatId: 70, id: FIRST_ID, phase: 'running' }))
      .resolves.toBe('updated');
    await expect(repository.findWorkflowReturn({ userId: 7, chatId: 70, now: later }))
      .resolves.toMatchObject({
        expiresAt: new Date('2030-01-02T06:00:00.000Z'),
        payload: { phase: 'running' },
      });
  });

  it('exposes the claimed, resumable, and terminal completion outcomes unchanged', async () => {
    const { begin, claim, complete } = lifecycleSetup();
    await begin.execute(beginInput());

    await expect(claim.execute({ userId: 7, chatId: 70, id: FIRST_ID }))
      .resolves.toMatchObject({ kind: 'claimed', receipt: { status: 'executing' } });
    await expect(claim.execute({ userId: 7, chatId: 70, id: FIRST_ID }))
      .resolves.toMatchObject({ kind: 'resumable', receipt: { status: 'executing' } });
    await expect(complete.execute({ userId: 7, chatId: 70, id: FIRST_ID, outcome: 'returned' }))
      .resolves.toBe('finished');
    await expect(complete.execute({ userId: 7, chatId: 70, id: FIRST_ID, outcome: 'completed' }))
      .resolves.toBe('finished');
    await expect(claim.execute({ userId: 7, chatId: 70, id: FIRST_ID }))
      .resolves.toEqual({ kind: 'terminal' });
  });

  it('forwards expired lifecycle outcomes without changing receipt state', async () => {
    const updateSetup = lifecycleSetup();
    await updateSetup.begin.execute(beginInput());
    updateSetup.setNow(new Date('2030-01-02T00:00:00.000Z'));
    await expect(updateSetup.update.execute({ userId: 7, chatId: 70, id: FIRST_ID, phase: 'running' }))
      .resolves.toBe('expired');

    const claimSetup = lifecycleSetup();
    await claimSetup.begin.execute(beginInput());
    claimSetup.setNow(new Date('2030-01-02T00:00:00.000Z'));
    await expect(claimSetup.claim.execute({ userId: 7, chatId: 70, id: FIRST_ID }))
      .resolves.toEqual({ kind: 'expired' });
  });

  it('forwards terminal phase-update and finish outcomes', async () => {
    const setup = lifecycleSetup();
    await setup.begin.execute(beginInput());
    await setup.claim.execute({ userId: 7, chatId: 70, id: FIRST_ID });
    await expect(setup.update.execute({ userId: 7, chatId: 70, id: FIRST_ID, phase: 'running' }))
      .resolves.toBe('terminal');
    await setup.complete.execute({ userId: 7, chatId: 70, id: FIRST_ID, outcome: 'completed' });
    await expect(setup.complete.execute({ userId: 7, chatId: 70, id: FIRST_ID, outcome: 'completed' }))
      .resolves.toBe('terminal');
  });

  it('forwards the returned claim outcome with the durable receipt', async () => {
    const { begin, claim, complete } = lifecycleSetup();
    await begin.execute(beginInput());
    await claim.execute({ userId: 7, chatId: 70, id: FIRST_ID });
    await complete.execute({ userId: 7, chatId: 70, id: FIRST_ID, outcome: 'returned' });

    await expect(claim.execute({ userId: 7, chatId: 70, id: FIRST_ID }))
      .resolves.toMatchObject({ kind: 'returned', receipt: { id: FIRST_ID, status: 'returned' } });
  });

  it('preserves executing, returned, and completed status precedence after expiry', async () => {
    const executing = lifecycleSetup();
    await executing.begin.execute(beginInput());
    await executing.claim.execute({ userId: 7, chatId: 70, id: FIRST_ID });
    executing.setNow(new Date('2030-01-02T00:00:00.000Z'));
    await expect(executing.claim.execute({ userId: 7, chatId: 70, id: FIRST_ID }))
      .resolves.toMatchObject({ kind: 'resumable', receipt: { status: 'executing' } });

    const returned = lifecycleSetup();
    await returned.begin.execute(beginInput());
    await returned.claim.execute({ userId: 7, chatId: 70, id: FIRST_ID });
    await returned.complete.execute({ userId: 7, chatId: 70, id: FIRST_ID, outcome: 'returned' });
    returned.setNow(new Date('2030-01-02T00:00:00.000Z'));
    await expect(returned.claim.execute({ userId: 7, chatId: 70, id: FIRST_ID }))
      .resolves.toMatchObject({ kind: 'returned', receipt: { status: 'returned' } });

    const completed = lifecycleSetup();
    await completed.begin.execute(beginInput());
    await completed.claim.execute({ userId: 7, chatId: 70, id: FIRST_ID });
    await completed.complete.execute({ userId: 7, chatId: 70, id: FIRST_ID, outcome: 'completed' });
    completed.setNow(new Date('2030-01-02T00:00:00.000Z'));
    await expect(completed.claim.execute({ userId: 7, chatId: 70, id: FIRST_ID }))
      .resolves.toEqual({ kind: 'terminal' });
  });
});

const summary = {
  verdict: 'normal' as const,
  sensors: [],
  attention: [],
  attentionTotal: 0,
  knownCount: 0,
  unknownCount: 0,
  health: null,
  healthFresh: false,
  notificationState: { kind: 'normal' as const },
};

function originSetup(options: { targetExists?: boolean } = {}) {
  const sensors = {
    listDashboardPage: vi.fn(async ({ page }: { page: number; pageSize: number }): Promise<SensorDashboardPage> => ({
      sensors: [], requestedPage: page, page: Math.min(page, 2), pageCount: 3, total: 17, clamped: page > 2,
    })),
  };
  const target = { ref: { kind: 'sensor' as const, id: SENSOR_ID }, name: 'Hall', kind: 'sensor' as const, muted: false };
  const targets = {
    listEnabled: vi.fn().mockResolvedValue([target]),
    findEnabled: vi.fn(async (ref: { id: string }) => options.targetExists === false || ref.id === MISSING_ID ? null : target),
  };
  const screens = new GetHomeScreenUseCase(
    { execute: vi.fn().mockResolvedValue(summary) },
    sensors,
    { execute: vi.fn().mockResolvedValue({ enabled: true }) },
    targets,
  );
  return { resolver: new ResolveWorkflowOriginUseCase(screens), screens, sensors, targets };
}

const NATURAL_ORIGINS: readonly [ExternalWorkflow, HomeView][] = [
  ['logs', { kind: 'history' }],
  ['csv', { kind: 'history' }],
  ['language', { kind: 'more' }],
  ['help', { kind: 'more' }],
  ['sensor-add', { kind: 'admin-sensor-setup' }],
  ['sensor-modify', { kind: 'admin-sensor-setup' }],
  ['sensor-remove', { kind: 'admin-sensor-setup' }],
  ['sensor-import', { kind: 'admin-sensor-setup' }],
  ['sensor-export', { kind: 'admin-sensor-setup' }],
  ['drive-status', { kind: 'admin-storage' }],
  ['drive-setup', { kind: 'admin-storage' }],
  ['storage-cleanup', { kind: 'admin-storage' }],
  ['health', { kind: 'admin-system' }],
  ['system-update', { kind: 'admin-system' }],
  ['system-restart', { kind: 'admin-system' }],
  ['invite', { kind: 'admin-tools' }],
  ['camera', { kind: 'home', checking: false }],
];

describe('ResolveWorkflowOriginUseCase', () => {
  it.each(NATURAL_ORIGINS)('maps direct %s workflows to their exhaustive natural parent', (workflow, expected) => {
    expect(naturalWorkflowOrigin(workflow)).toEqual(expected);
  });

  it('uses a valid captured origin before the workflow natural parent', async () => {
    const { resolver } = originSetup();
    await expect(resolver.execute({
      userId: 7, chatId: 70, role: 'user', workflow: 'camera',
      requested: { kind: 'history' }, originSource: 'captured',
    })).resolves.toEqual({ kind: 'history' });
  });

  it.each([
    { kind: 'admin-tools' },
    { kind: 'admin-sensor-setup' },
    { kind: 'admin-storage' },
    { kind: 'admin-system' },
    { kind: 'admin-cleanup-threshold' },
    { kind: 'confirmation', action: 'cleanup', receiptId: FIRST_ID },
    { kind: 'confirmation', action: 'restart', receiptId: FIRST_ID },
    { kind: 'cleanup-result', outcome: 'executed', threshold: 80 },
  ] satisfies HomeView[])('walks a demoted user from admin origin $kind to More', async (requested) => {
    const { resolver } = originSetup();
    await expect(resolver.execute({
      userId: 7, chatId: 70, role: 'user', workflow: 'camera', requested, originSource: 'captured',
    })).resolves.toEqual({ kind: 'more' });
  });

  it('falls back from a deleted notification target to its normalized containing list', async () => {
    const { resolver } = originSetup({ targetExists: false });
    await expect(resolver.execute({
      userId: 7, chatId: 70, role: 'user', workflow: 'help', originSource: 'captured',
      requested: { kind: 'notification-target', page: 12, target: { kind: 'sensor', id: MISSING_ID } },
    })).resolves.toEqual({
      kind: 'notification-targets', page: 0, targets: [{ kind: 'sensor', id: SENSOR_ID }],
    });
  });

  it('clamps the containing-list page of a surviving notification target', async () => {
    const { resolver } = originSetup();
    await expect(resolver.execute({
      userId: 7, chatId: 70, role: 'user', workflow: 'help', originSource: 'captured',
      requested: { kind: 'notification-target', page: 12, target: { kind: 'sensor', id: SENSOR_ID } },
    })).resolves.toEqual({
      kind: 'notification-target', page: 0, target: { kind: 'sensor', id: SENSOR_ID },
    });
  });

  it('persists the clamped page returned by dynamic screen construction', async () => {
    const { resolver } = originSetup();
    await expect(resolver.execute({
      userId: 7, chatId: 70, role: 'user', workflow: 'camera', originSource: 'captured',
      requested: { kind: 'sensors', page: 12, checking: false },
    })).resolves.toEqual({ kind: 'sensors', page: 2, checking: false });
  });

  it('uses the natural parent when a runtime origin is malformed', async () => {
    const { resolver } = originSetup();
    await expect(resolver.execute({
      userId: 7, chatId: 70, role: 'user', workflow: 'logs', originSource: 'captured',
      requested: { kind: 'sensors', page: -1, checking: false },
    })).resolves.toEqual({ kind: 'history' });
  });

  it('reauthorizes a direct-command natural parent instead of trusting the supplied view', async () => {
    const { resolver } = originSetup();
    await expect(resolver.execute({
      userId: 7, chatId: 70, role: 'admin', workflow: 'logs', originSource: 'natural-parent',
      requested: { kind: 'admin-system' },
    })).resolves.toEqual({ kind: 'history' });
  });

  it('walks an unauthorized direct-command natural parent to its authorized ancestor', async () => {
    const { resolver } = originSetup();
    await expect(resolver.execute({
      userId: 7, chatId: 70, role: 'user', workflow: 'sensor-add', originSource: 'natural-parent',
      requested: { kind: 'home', checking: false },
    })).resolves.toEqual({ kind: 'more' });
  });
});

const HOME_SCREEN: HomeScreen = { kind: 'home', summary, checking: false };

function restoreSetup() {
  const sessions = new InMemoryHomeSessionStore();
  const delivery = new InMemoryHomeMessageDeliveryAdapter();
  const screens = { execute: vi.fn().mockResolvedValue(HOME_SCREEN) };
  const open = new OpenHomeUseCase(
    sessions,
    { generate: () => FIRST_ID },
    screens,
    delivery,
    { now: () => NOW },
  );
  const resolve = { execute: vi.fn().mockResolvedValue({ kind: 'home', checking: false }) };
  return { sessions, delivery, screens, resolve, restore: new RestoreWorkflowOriginUseCase(resolve, open) };
}

describe('RestoreWorkflowOriginUseCase', () => {
  it('returns opened and sends a transient notice without persisting it in HomeView', async () => {
    const { sessions, delivery, restore } = restoreSetup();
    const input = {
      userId: 7, chatId: 70, locale: 'en' as const, role: 'user' as const,
      workflow: 'camera' as const, requested: { kind: 'home', checking: false } as const,
      originSource: 'captured' as const, notice: 'Camera finished.',
    };

    const result = await restore.execute(input);
    expect(result).toMatchObject({
      kind: 'opened', view: { kind: 'home', checking: false },
    });
    expect(delivery.calls[0]).toMatchObject({ kind: 'send', input: { notice: 'Camera finished.' } });
    if (result.kind !== 'opened') throw new Error('expected opened Home');
    await expect(sessions.validate({ ...result.active, now: NOW })).resolves.toMatchObject({
      kind: 'accepted', view: { kind: 'home', checking: false },
    });
  });

  it('returns resumable when a newly sent Home loses promotion', async () => {
    const { sessions, delivery, restore } = restoreSetup();
    delivery.onSend = async () => {
      await sessions.reserveNew({
        userId: 7, chatId: 70, token: SECOND_ID, view: { kind: 'home', checking: false },
        now: NOW, expiresAt: new Date(NOW.getTime() + 60_000),
      });
    };

    await expect(restore.execute({
      userId: 7, chatId: 70, locale: 'en', role: 'user', workflow: 'camera',
      requested: { kind: 'home', checking: false }, originSource: 'captured',
    })).resolves.toEqual({ kind: 'resumable' });
  });

  it('does not hide Home delivery errors behind a resumable result', async () => {
    const { delivery, restore } = restoreSetup();
    const failure = new Error('delivery failed');
    delivery.sendError = failure;

    await expect(restore.execute({
      userId: 7, chatId: 70, locale: 'en', role: 'user', workflow: 'camera',
      requested: { kind: 'home', checking: false }, originSource: 'captured',
    })).rejects.toBe(failure);
  });
});

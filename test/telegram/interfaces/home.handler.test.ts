import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { OpenHomeUseCase } from '../../../src/telegram/application/open-home.use-case';
import { RenderHomeUseCase } from '../../../src/telegram/application/render-home.use-case';
import { RefreshHomeMonitoringUseCase } from '../../../src/telegram/application/refresh-home-monitoring.use-case';
import { ValidateHomeCallbackUseCase } from '../../../src/telegram/application/validate-home-callback.use-case';
import { HomeNavigationUseCase } from '../../../src/telegram/application/home-navigation.use-case';
import { HomeHandler } from '../../../src/telegram/interfaces/home.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { encodeHomeCallback, OPEN_NEW_HOME_CALLBACK } from '../../../src/telegram/domain/home-callback';
import { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';
import { WorkflowOperationQueue } from '../../../src/telegram/interfaces/workflow-operation.queue';
import type { BeginWorkflowReturnUseCase } from '../../../src/telegram/application/begin-workflow-return.use-case';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';

const identity = {
  userId: 100,
  chatId: 200,
  messageId: 300,
  token: 'AbCdEfGhIjKlMn_-',
  revision: 1,
};
const workflowReceipt = {
  id: 'qrstuvwxyzabcdef',
  userId: 100,
  chatId: 200,
  kind: 'workflow-return',
  sessionToken: identity.token,
  status: 'pending',
  expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: {
    workflow: 'camera',
    phase: 'cancellable',
    originSource: 'captured',
    origin: { kind: 'home', checking: false },
  },
} satisfies WorkflowReturnReceipt;

function localeState(role: 'admin' | 'user' = 'user', locale: 'en' | 'uk' = 'en') {
  return {
    user: { telegramId: 100, name: 'Alex', role, locale, muted: false, quietStart: null, quietEnd: null, createdAt: null },
    locale,
    catalog: catalogFor(locale),
  };
}

function context(data?: string) {
  return {
    from: { id: 100 },
    chat: { id: 200, type: 'private' },
    callbackQuery: data ? { data, message: { message_id: 300 } } : undefined,
    localeState: localeState(),
    reply: vi.fn().mockResolvedValue({ message_id: 301 }),
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  };
}

function activeCheckCoordinator(
  phase: 'cancellable' | 'running',
  events: string[],
) {
  const receipt = {
    ...workflowReceipt,
    payload: { ...workflowReceipt.payload, phase },
  } satisfies WorkflowReturnReceipt;
  const actions = {
    findWorkflowReturn: vi.fn().mockImplementation(async () => {
      events.push('find-workflow');
      return receipt;
    }),
    claimWorkflowReturn: vi.fn().mockImplementation(async () => {
      events.push('claim-workflow');
      return { kind: 'claimed' as const, receipt };
    }),
    finishWorkflowReturn: vi.fn().mockImplementation(async () => {
      events.push('finish-workflow');
      return 'finished' as const;
    }),
  };
  const drafts = new WorkflowDraftRegistry();
  drafts.register('camera', {
    cancelExact: async () => {
      events.push('cancel-draft');
      return 'cancelled';
    },
  });
  return {
    actions,
    coordinator: new WorkflowEntryCoordinator(
      { execute: vi.fn() } as unknown as BeginWorkflowReturnUseCase,
      drafts,
      new WorkflowOperationQueue(),
      actions as never,
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
    ),
  };
}

function setup(overrides: {
  clean?: { execute: ReturnType<typeof vi.fn> };
  restart?: { execute: ReturnType<typeof vi.fn> };
  thresholds?: { execute: ReturnType<typeof vi.fn> };
  actions?: { finishExternal: ReturnType<typeof vi.fn> };
  workflows?: WorkflowEntryCoordinator;
  logs?: { handleEmpty: ReturnType<typeof vi.fn> };
  csv?: { handleEmpty: ReturnType<typeof vi.fn> };
  settings?: { handleCommand: ReturnType<typeof vi.fn> };
  config?: { handleSubcommand: ReturnType<typeof vi.fn> };
  help?: { handleCommand: ReturnType<typeof vi.fn> };
  drive?: { handleStatus: ReturnType<typeof vi.fn> };
  driveAuth?: { handleCommand: ReturnType<typeof vi.fn> };
  health?: { handleCommand: ReturnType<typeof vi.fn> };
  invite?: { handleCommand: ReturnType<typeof vi.fn> };
  importConfig?: { handleCommand: ReturnType<typeof vi.fn> };
  exportConfig?: { handleCommand: ReturnType<typeof vi.fn> };
  systemUpdate?: { handleCommand: ReturnType<typeof vi.fn> };
  workflowNavigation?: { complete: ReturnType<typeof vi.fn> };
} = {}) {
  const guard = { registered: vi.fn() } as unknown as RoleMiddleware;
  const open = {
    execute: vi.fn().mockResolvedValue({ kind: 'opened', active: identity, view: { kind: 'home', checking: false } }),
  } as unknown as OpenHomeUseCase;
  const validate = { execute: vi.fn().mockResolvedValue({ kind: 'accepted', active: identity, view: { kind: 'home', checking: false } }) } as unknown as ValidateHomeCallbackUseCase;
  const render = {
    execute: vi.fn().mockResolvedValue({
      kind: 'rendered', active: { ...identity, revision: 2 }, view: { kind: 'home', checking: false },
    }),
  } as unknown as RenderHomeUseCase;
  const refresh = { execute: vi.fn().mockResolvedValue({ kind: 'refreshed' }) } as unknown as RefreshHomeMonitoringUseCase;
  const camera = { handleDashboard: vi.fn().mockResolvedValue(undefined) } as any;
  const navigation = {
    route: vi.fn().mockImplementation(({ action }: any) => ({
      kind: action.kind === 'camera' ? 'external' : ['confirm-pause', 'auto-clean-threshold', 'confirm-cleanup'].includes(action.kind) ? 'effect' : 'render',
      destination: action.kind === 'camera' ? 'camera' : undefined,
      view: action.kind === 'sensors'
        ? { kind: 'sensors', page: action.page, checking: false }
        : action.kind === 'home'
          ? { kind: 'home', checking: false }
          : { kind: 'notifications' },
    })),
    executeEffect: vi.fn().mockImplementation(({ action }: any) => Promise.resolve({
    kind: action.kind === 'camera' ? 'external' : 'render',
    destination: action.kind === 'camera' ? 'camera' : undefined,
    view: action.kind === 'sensors'
      ? { kind: 'sensors', page: action.page, checking: false }
      : action.kind === 'home'
        ? { kind: 'home', checking: false }
        : { kind: 'notifications' },
    })),
  } as unknown as HomeNavigationUseCase;
  const workflowEntry = {
    begin: vi.fn().mockResolvedValue(workflowReceipt),
    markRunning: vi.fn().mockResolvedValue(true),
    leaveForHome: vi.fn().mockResolvedValue('no-workflow'),
  } as unknown as WorkflowEntryCoordinator;
  const handler = new HomeHandler(
    guard, open, validate, render, refresh, camera, navigation,
    overrides.logs, // logs
    overrides.csv, // csv
    overrides.settings, // settings
    overrides.help, // help
    overrides.config, // config
    overrides.drive, // drive
    overrides.driveAuth, // drive auth
    overrides.health, // health
    overrides.invite, // invite
    overrides.importConfig, // import config
    overrides.exportConfig, // export config
    overrides.systemUpdate, // system update
    overrides.clean, // clean
    overrides.restart, // restart
    overrides.thresholds, // thresholds
    undefined, // target mute
    overrides.actions, // action repository
    { now: () => new Date('2030-01-01T00:00:00.000Z') },
    overrides.workflows ?? workflowEntry,
    overrides.workflowNavigation as never,
  );
  const commands: Record<string, (...args: any[]) => Promise<void>> = {};
  const callbacks: { regex: RegExp; fn: (...args: any[]) => Promise<void> }[] = [];
  handler.register({
    command: vi.fn((name, middleware, fn) => { commands[name] = fn ?? middleware; }),
    callbackQuery: vi.fn((regex, middleware, fn) => { callbacks.push({ regex, fn: fn ?? middleware }); }),
  } as any);
  return { commands, callbacks, open, validate, render, refresh, camera, navigation, workflowEntry: overrides.workflows ?? workflowEntry, ctx: context() };
}

describe('HomeHandler', () => {
  it('opens Home from /menu for the current registered private user without probing health', async () => {
    const { commands, open, refresh, workflowEntry } = setup();
    const ctx = context();

    await commands.menu(ctx);

    expect(open.execute).toHaveBeenCalledWith({
      userId: 100, chatId: 200, locale: 'en', role: 'user', view: { kind: 'home', checking: false },
    });
    expect(workflowEntry.leaveForHome).toHaveBeenCalledWith(ctx, expect.any(Function));
    expect(refresh.execute).not.toHaveBeenCalled();
  });

  it('deletes the Open-new-Home recovery prompt after the new Home opens', async () => {
    const { callbacks, open } = setup();
    const ctx = context(OPEN_NEW_HOME_CALLBACK);

    await callbacks[0].fn(ctx);

    expect(open.execute).toHaveBeenCalledOnce();
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(200, 300);
    expect((open.execute as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      ctx.api.deleteMessage.mock.invocationCallOrder[0],
    );
  });

  it('ignores recovery-prompt deletion failure after the new Home opens', async () => {
    const { callbacks } = setup();
    const ctx = context(OPEN_NEW_HOME_CALLBACK);
    ctx.api.deleteMessage.mockRejectedValueOnce(new Error('message is already gone'));

    await expect(callbacks[0].fn(ctx)).resolves.toBeUndefined();
  });

  it.each(['superseded', 'unavailable'] as const)(
    'retains the Open-new-Home recovery prompt when opening is %s',
    async (outcome) => {
      const { callbacks, open } = setup();
      const ctx = context(OPEN_NEW_HOME_CALLBACK);
      if (outcome === 'superseded') {
        (open.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'superseded' });
      } else {
        (open.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('send failed'));
      }

      await callbacks[0].fn(ctx);

      expect(ctx.api.deleteMessage).not.toHaveBeenCalled();
    },
  );

  it('recovers malformed callbacks without mutating Home state', async () => {
    const { callbacks, validate, render, refresh, camera, workflowEntry } = setup();
    const ctx = context('h:not-a-token:1:k');

    await callbacks[0].fn(ctx);

    expect(validate.execute).not.toHaveBeenCalled();
    expect(render.execute).not.toHaveBeenCalled();
    expect(refresh.execute).not.toHaveBeenCalled();
    expect(camera.handleDashboard).not.toHaveBeenCalled();
    expect(workflowEntry.leaveForHome).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      ctx.localeState.catalog.home.recovery.stale,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('renders the requested Sensors page using the current locale and role after validation', async () => {
    const { callbacks, validate, render } = setup();
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'sensors', page: 4 }));
    ctx.localeState = localeState('admin', 'uk');

    await callbacks[0].fn(ctx);

    expect(validate.execute).toHaveBeenCalledWith({ parsed: expect.anything(), userId: 100, chatId: 200, messageId: 300 });
    expect(render.execute).toHaveBeenCalledWith({
      active: identity, locale: 'uk', role: 'admin', view: { kind: 'sensors', page: 4, checking: false },
    });
  });

  it('keeps the page clamped while a refresh grows the sensor list', async () => {
    const { callbacks, validate, render, refresh } = setup();
    const checkingIdentity = { ...identity, revision: 2 };
    (validate.execute as any).mockResolvedValue({ kind: 'accepted', active: identity, view: { kind: 'sensors', page: 3, checking: false } });
    (render.execute as any)
      .mockResolvedValueOnce({
        kind: 'reopened', active: checkingIdentity,
        view: { kind: 'sensors', page: 0, checking: true },
      })
      .mockResolvedValueOnce({
        kind: 'rendered', active: { ...identity, revision: 3 },
        view: { kind: 'sensors', page: 0, checking: false },
      });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'check' }));

    await callbacks[0].fn(ctx);

    expect(render.execute).toHaveBeenNthCalledWith(1, {
      active: identity, locale: 'en', role: 'user', view: { kind: 'sensors', page: 3, checking: true },
    });
    expect(refresh.execute).toHaveBeenCalledTimes(1);
    expect(render.execute).toHaveBeenNthCalledWith(2, {
      active: checkingIdentity, locale: 'en', role: 'user', view: { kind: 'sensors', page: 0, checking: false },
    });
  });

  it('clears the checking state after an unexpected refresh failure', async () => {
    const { callbacks, render, refresh } = setup();
    (refresh.execute as any).mockRejectedValue(new Error('probe unavailable'));
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'check' }));

    await callbacks[0].fn(ctx);

    expect(render.execute).toHaveBeenCalledTimes(2);
    expect(render.execute).toHaveBeenLastCalledWith(expect.objectContaining({
      view: { kind: 'home', checking: false },
    }));
  });

  it.each([
    ['cancellable', true],
    ['running', false],
  ] as const)('leaves an active %s workflow before Check renders and refreshes a fresh Home identity', async (phase, cancelsDraft) => {
    const events: string[] = [];
    const { coordinator } = activeCheckCoordinator(phase, events);
    const { callbacks, validate, open, render, refresh } = setup({ workflows: coordinator });
    const fresh = { ...identity, messageId: 901, token: 'QrStUvWxYz012345', revision: 8 };
    const checking = { ...fresh, revision: 9 };
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'check' }));
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'accepted', active: identity, view: { kind: 'sensors', page: 3, checking: false },
    });
    (open.execute as ReturnType<typeof vi.fn>).mockImplementation(async (input) => {
      events.push(`open-fresh:${input.view.kind}:${input.view.checking}`);
      return { kind: 'opened', active: fresh, view: input.view };
    });
    (render.execute as ReturnType<typeof vi.fn>).mockImplementation(async (input) => {
      events.push(`render:${input.active.messageId}:${input.active.revision}:${input.view.checking}`);
      return { kind: 'rendered', active: input.view.checking ? checking : { ...fresh, revision: 10 }, view: input.view };
    });
    (refresh.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('refresh-monitoring');
      return { kind: 'refreshed' };
    });

    await callbacks[0].fn(ctx);

    const expected = [
      'find-workflow',
      'claim-workflow',
      ...(cancelsDraft ? ['cancel-draft'] : []),
      'open-fresh:sensors:false',
      'finish-workflow',
      'render:901:8:true',
      'refresh-monitoring',
      'render:901:9:false',
    ];
    expect(events).toEqual(expected);
    expect(render.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      active: fresh,
      view: { kind: 'sensors', page: 3, checking: true },
    }));
    expect(render.execute).not.toHaveBeenCalledWith(expect.objectContaining({ active: identity }));
  });

  it('keeps the active workflow resumable and does not refresh when fresh Check promotion fails', async () => {
    const events: string[] = [];
    const { coordinator, actions } = activeCheckCoordinator('cancellable', events);
    const { callbacks, open, render, refresh } = setup({ workflows: coordinator });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'check' }));
    (open.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'superseded' });

    await callbacks[0].fn(ctx);

    expect(events).toEqual(['find-workflow', 'claim-workflow', 'cancel-draft']);
    expect(actions.finishWorkflowReturn).not.toHaveBeenCalled();
    expect(render.execute).not.toHaveBeenCalled();
    expect(refresh.execute).not.toHaveBeenCalled();
  });

  it('does not claim or refresh for a stale Check callback', async () => {
    const { callbacks, validate, workflowEntry, open, render, refresh } = setup();
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'check' }));
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'stale' });

    await callbacks[0].fn(ctx);

    expect(workflowEntry.leaveForHome).not.toHaveBeenCalled();
    expect(open.execute).not.toHaveBeenCalled();
    expect(render.execute).not.toHaveBeenCalled();
    expect(refresh.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['updating', 'updating'],
    ['stale', 'stale'],
    ['closed', 'stale'],
  ] as const)('fails closed for %s callback state', async (kind, copy) => {
    const { callbacks, validate, render, camera } = setup();
    (validate.execute as any).mockResolvedValue({ kind });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'camera' }));

    await callbacks[0].fn(ctx);

    expect(render.execute).not.toHaveBeenCalled();
    expect(camera.handleDashboard).not.toHaveBeenCalled();
    if (copy === 'updating') {
      expect(ctx.reply).toHaveBeenCalledWith(ctx.localeState.catalog.home.recovery.updating);
    } else {
      expect(ctx.reply).toHaveBeenCalledWith(
        ctx.localeState.catalog.home.recovery.stale,
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
    }
  });

  it('routes Notifications through Home navigation and renders its returned Home view', async () => {
    const { callbacks, render, navigation } = setup();
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'notifications' }));

    await callbacks[0].fn(ctx);

    expect(navigation.route).toHaveBeenCalledWith(expect.objectContaining({ action: { kind: 'notifications' } }));
    expect(render.execute).toHaveBeenCalledWith(expect.objectContaining({ view: { kind: 'notifications' } }));
  });

  it('starts Camera exactly once with the validated Home origin and existing workflow receipt', async () => {
    const { callbacks, render, camera, navigation, workflowEntry } = setup();
    const action = { kind: 'camera' } as const;
    const ctx = context(encodeHomeCallback(identity.token, 1, action));

    await callbacks[0].fn(ctx);

    expect(render.execute).not.toHaveBeenCalled();
    expect(navigation.route).toHaveBeenCalledWith(expect.objectContaining({ action }));
    expect(workflowEntry.begin).toHaveBeenCalledWith(ctx, 'camera', {
      source: 'captured',
      view: { kind: 'home', checking: false },
      sessionToken: identity.token,
    });
    expect(camera.handleDashboard).toHaveBeenCalledWith(ctx, { receipt: workflowReceipt });
  });

  it.each([
    ['history-logs', 'logs', 'logs'],
    ['history-csv', 'csv', 'csv'],
  ] as const)('starts Home-launched %s with its exact captured History origin', async (actionKind, workflow, target) => {
    const logs = { handleEmpty: vi.fn().mockResolvedValue(undefined) };
    const csv = { handleEmpty: vi.fn().mockResolvedValue(undefined) };
    const { callbacks, navigation, workflowEntry } = setup({ logs, csv });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: actionKind }));
    (navigation.route as ReturnType<typeof vi.fn>).mockReturnValue({
      kind: 'external', destination: actionKind,
    });
    (workflowEntry.begin as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...workflowReceipt,
      payload: { ...workflowReceipt.payload, workflow },
    });

    await callbacks[0].fn(ctx);

    expect(workflowEntry.begin).toHaveBeenCalledWith(ctx, workflow, {
      source: 'captured',
      view: { kind: 'home', checking: false },
      sessionToken: identity.token,
    });
    const handler = target === 'logs' ? logs.handleEmpty : csv.handleEmpty;
    expect(handler).toHaveBeenCalledWith(ctx, {
      receipt: expect.objectContaining({ payload: expect.objectContaining({ workflow }) }),
    });
  });

  it('starts a Home-launched sensor editor once with its captured Sensor setup origin', async () => {
    const config = { handleSubcommand: vi.fn().mockResolvedValue(undefined) };
    const { callbacks, validate, navigation, workflowEntry } = setup({ config });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'config-modify' }));
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'accepted', active: identity, view: { kind: 'admin-sensor-setup' },
    });
    (navigation.route as ReturnType<typeof vi.fn>).mockReturnValue({
      kind: 'external', destination: 'config-modify',
    });

    await callbacks[0].fn(ctx);

    expect(workflowEntry.begin).toHaveBeenCalledWith(ctx, 'sensor-modify', {
      source: 'captured',
      view: { kind: 'admin-sensor-setup' },
      sessionToken: identity.token,
    });
    expect(config.handleSubcommand).toHaveBeenCalledWith(ctx, 'modify', { receipt: workflowReceipt });
  });

  it('starts a Home-launched language selector once with its captured More origin', async () => {
    const settings = { handleCommand: vi.fn().mockResolvedValue(undefined) };
    const { callbacks, validate, navigation, workflowEntry } = setup({ settings });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'settings' }));
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'accepted', active: identity, view: { kind: 'more' },
    });
    (navigation.route as ReturnType<typeof vi.fn>).mockReturnValue({
      kind: 'external', destination: 'settings',
    });

    await callbacks[0].fn(ctx);

    expect(workflowEntry.begin).toHaveBeenCalledWith(ctx, 'language', {
      source: 'captured',
      view: { kind: 'more' },
      sessionToken: identity.token,
    });
    expect(settings.handleCommand).toHaveBeenCalledWith(ctx, { receipt: workflowReceipt });
  });

  it.each([
    ['config-import', 'sensor-import', 'importConfig', 'handleCommand'],
    ['config-export', 'sensor-export', 'exportConfig', 'handleCommand'],
    ['drive-status', 'drive-status', 'drive', 'handleStatus'],
    ['drive-connect', 'drive-setup', 'driveAuth', 'handleCommand'],
    ['system-health', 'health', 'health', 'handleCommand'],
    ['system-packages', 'system-update', 'systemUpdate', 'handleCommand'],
    ['invite', 'invite', 'invite', 'handleCommand'],
    ['help', 'help', 'help', 'handleCommand'],
  ] as const)('begins %s exactly once from its captured Admin/Home origin', async (destination, workflow, dependency, method) => {
    const target = { [method]: vi.fn().mockResolvedValue(undefined) };
    const { callbacks, validate, navigation, workflowEntry } = setup({ [dependency]: target });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: destination }));
    const origin = destination === 'help' ? { kind: 'more' } : destination === 'invite'
      ? { kind: 'admin-tools' }
      : destination.startsWith('config-') ? { kind: 'admin-sensor-setup' }
        : destination.startsWith('drive-') ? { kind: 'admin-storage' }
          : { kind: 'admin-system' };
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'accepted', active: identity, view: origin,
    });
    (navigation.route as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'external', destination });

    await callbacks[0].fn(ctx);

    expect(workflowEntry.begin).toHaveBeenCalledWith(ctx, workflow, {
      source: 'captured', view: origin, sessionToken: identity.token,
    });
    if (destination === 'drive-status') {
      expect(target.handleStatus).toHaveBeenCalledWith(ctx, { includeCleanupAction: false }, { receipt: workflowReceipt });
    } else {
      expect(target[method]).toHaveBeenCalledWith(ctx, { receipt: workflowReceipt });
    }
  });

  it('opens a validated Home destination freshly at the bottom after workflow leave succeeds', async () => {
    const { callbacks, open, render, workflowEntry } = setup();
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'sensors', page: 2 }));
    (workflowEntry.leaveForHome as ReturnType<typeof vi.fn>).mockImplementation(async (_ctx, promote) => {
      await promote();
      return 'opened';
    });

    await callbacks[0].fn(ctx);

    expect(render.execute).not.toHaveBeenCalled();
    expect(open.execute).toHaveBeenCalledWith(expect.objectContaining({
      view: { kind: 'sensors', page: 2, checking: false },
    }));
  });

  it('does not leave a workflow or promote a fresh Home for an invalid callback', async () => {
    const { callbacks, open, workflowEntry } = setup();
    const ctx = context('h:not-a-token:1:s:2');

    await callbacks[0].fn(ctx);

    expect(workflowEntry.leaveForHome).not.toHaveBeenCalled();
    expect(open.execute).not.toHaveBeenCalled();
  });

  it('renders the localized in-progress recovery for a repeated claimed cleanup', async () => {
    const { callbacks, validate, navigation } = setup();
    (validate.execute as any).mockResolvedValue({
      kind: 'accepted', active: identity,
      view: { kind: 'confirmation', action: 'cleanup', receiptId: '1234567890abcdef' },
    });
    (navigation.route as any).mockReturnValue({ kind: 'recovery', reason: 'executing' });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'confirm-cleanup', receiptId: '1234567890abcdef' }));

    await callbacks[0].fn(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(ctx.localeState.catalog.home.cleanupResult.inProgress);
  });

  it('renders a validated legacy refresh in place without touching the active workflow', async () => {
    const { callbacks, render, navigation, workflowEntry, open, camera } = setup();
    const ctx = context(`h:${identity.token}:1:x`);
    (workflowEntry.leaveForHome as ReturnType<typeof vi.fn>).mockResolvedValue('opened');

    await callbacks[0].fn(ctx);

    expect(render.execute).toHaveBeenCalledWith(expect.objectContaining({
      active: identity,
      view: { kind: 'home', checking: false },
    }));
    expect(navigation.route).not.toHaveBeenCalled();
    expect(navigation.executeEffect).not.toHaveBeenCalled();
    expect(workflowEntry.leaveForHome).not.toHaveBeenCalled();
    expect(workflowEntry.begin).not.toHaveBeenCalled();
    expect(open.execute).not.toHaveBeenCalled();
    expect(camera.handleDashboard).not.toHaveBeenCalled();
  });

  it('leaves an active workflow before confirming a validated pause and freshly promotes the result', async () => {
    const events: string[] = [];
    const { callbacks, validate, navigation, workflowEntry, open, render } = setup();
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'confirm-pause', receiptId: '1234567890abcdef' }));
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'accepted', active: identity,
      view: { kind: 'pause-confirmation', hours: 4, receiptId: '1234567890abcdef' },
    });
    (navigation.route as ReturnType<typeof vi.fn>).mockImplementation(() => ({ kind: 'effect' }));
    (navigation.executeEffect as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('confirm-pause');
      return { kind: 'render', view: { kind: 'notifications' } };
    });
    (workflowEntry.leaveForHome as ReturnType<typeof vi.fn>).mockImplementation(async (_ctx, promote) => {
      events.push('leave-workflow');
      await promote();
      return 'opened';
    });
    (open.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('open-fresh');
      return { kind: 'opened' };
    });

    await callbacks[0].fn(ctx);

    expect(events).toEqual(['leave-workflow', 'confirm-pause', 'open-fresh']);
    expect(render.execute).not.toHaveBeenCalled();
  });

  it('leaves an active workflow before applying a cleanup threshold and freshly promotes the result', async () => {
    const events: string[] = [];
    const thresholds = { execute: vi.fn().mockImplementation(async () => { events.push('set-threshold'); }) };
    const { callbacks, validate, navigation, workflowEntry, open, render } = setup({ thresholds });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'auto-clean-threshold', value: 80 }));
    ctx.localeState = localeState('admin');
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'accepted', active: identity, view: { kind: 'admin-cleanup-threshold' },
    });
    (navigation.route as ReturnType<typeof vi.fn>).mockImplementation(() => ({ kind: 'effect' }));
    (navigation.executeEffect as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('validate-threshold-effect');
      return { kind: 'render', view: { kind: 'admin-cleanup-threshold' } };
    });
    (workflowEntry.leaveForHome as ReturnType<typeof vi.fn>).mockImplementation(async (_ctx, promote) => {
      events.push('leave-workflow');
      await promote();
      return 'opened';
    });
    (open.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('open-fresh');
      return { kind: 'opened' };
    });

    await callbacks[0].fn(ctx);

    expect(events).toEqual(['leave-workflow', 'validate-threshold-effect', 'set-threshold', 'open-fresh']);
    expect(render.execute).not.toHaveBeenCalled();
  });

  it('leaves an active workflow before dispatching a confirmed cleanup and freshly promotes its result', async () => {
    const events: string[] = [];
    const clean = { execute: vi.fn().mockImplementation(async () => {
      events.push('dispatch-cleanup');
      return { executed: true, thresholdUsed: 80 };
    }) };
    const actions = { finishExternal: vi.fn().mockImplementation(async () => { events.push('finish-cleanup'); }) };
    const { callbacks, validate, navigation, workflowEntry, open, render } = setup({ clean, actions });
    const receiptId = '1234567890abcdef';
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'confirm-cleanup', receiptId }));
    ctx.localeState = localeState('admin');
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'accepted', active: identity,
      view: { kind: 'confirmation', action: 'cleanup', receiptId },
    });
    (navigation.route as ReturnType<typeof vi.fn>).mockImplementation(() => ({ kind: 'effect' }));
    (navigation.executeEffect as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('claim-cleanup');
      return { kind: 'render', view: { kind: 'cleanup-result', outcome: 'in-progress', threshold: null } };
    });
    (workflowEntry.leaveForHome as ReturnType<typeof vi.fn>).mockImplementation(async (_ctx, promote) => {
      events.push('leave-workflow');
      await promote();
      return 'opened';
    });
    (open.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('open-fresh');
      return { kind: 'opened' };
    });

    await callbacks[0].fn(ctx);

    expect(events).toEqual(['leave-workflow', 'claim-cleanup', 'dispatch-cleanup', 'finish-cleanup', 'open-fresh']);
    expect(render.execute).not.toHaveBeenCalled();
  });

  it('leaves an active workflow before dispatching a confirmed restart and freshly promotes System', async () => {
    const events: string[] = [];
    const restart = { execute: vi.fn().mockImplementation(async () => { events.push('dispatch-restart'); }) };
    const actions = { finishExternal: vi.fn().mockImplementation(async () => { events.push('finish-restart'); }) };
    const { callbacks, validate, navigation, workflowEntry, open, render } = setup({ restart, actions });
    const receiptId = '1234567890abcdef';
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'confirm-restart', receiptId }));
    ctx.localeState = localeState('admin');
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'accepted', active: identity,
      view: { kind: 'confirmation', action: 'restart', receiptId },
    });
    (navigation.route as ReturnType<typeof vi.fn>).mockImplementation(() => ({ kind: 'effect' }));
    (navigation.executeEffect as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('claim-restart');
      return { kind: 'restart' };
    });
    (workflowEntry.leaveForHome as ReturnType<typeof vi.fn>).mockImplementation(async (_ctx, promote) => {
      events.push('leave-workflow');
      await promote();
      return 'opened';
    });
    (workflowEntry.begin as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('begin-system-restart');
      return workflowReceipt;
    });
    (workflowEntry.markRunning as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('mark-system-restart-running');
      return true;
    });
    (open.execute as ReturnType<typeof vi.fn>).mockImplementation(async (input) => {
      events.push(`open-fresh:${input.view.kind}`);
      return { kind: 'opened' };
    });

    await callbacks[0].fn(ctx);

    expect(events).toEqual([
      'leave-workflow',
      'claim-restart',
      'begin-system-restart',
      'mark-system-restart-running',
      'dispatch-restart',
      'finish-restart',
      'open-fresh:admin-system',
    ]);
    expect(workflowEntry.begin).toHaveBeenCalledWith(ctx, 'system-restart', {
      source: 'captured',
      view: { kind: 'admin-system' },
      sessionToken: identity.token,
    });
    expect(render.execute).not.toHaveBeenCalled();
  });

  it('delivers a started restart failure before shared workflow recovery restores its System origin', async () => {
    const events: string[] = [];
    const restart = { execute: vi.fn(async () => {
      events.push('dispatch-restart');
      throw new Error('service unavailable');
    }) };
    const actions = { finishExternal: vi.fn(async () => { events.push('finish-restart'); }) };
    const workflowNavigation = {
      complete: vi.fn(async (_ctx, _launch, presentation) => {
        await presentation.deliver();
        events.push('restore-system');
      }),
    };
    const { callbacks, validate, navigation, workflowEntry, ctx } = setup({
      restart,
      actions,
      workflowNavigation,
    });
    const receiptId = '1234567890abcdef';
    ctx.callbackQuery = {
      data: encodeHomeCallback(identity.token, 1, { kind: 'confirm-restart', receiptId }),
      message: { message_id: 300 },
    };
    ctx.localeState = localeState('admin');
    ctx.reply.mockImplementation(async (text: string) => {
      if (text === ctx.localeState.catalog.ota.restartFailed('service unavailable')) {
        events.push('terminal-error');
      }
    });
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'accepted',
      active: identity,
      view: { kind: 'confirmation', action: 'restart', receiptId },
    });
    (navigation.route as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'effect' });
    (navigation.executeEffect as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('claim-restart');
      return { kind: 'restart' };
    });
    (workflowEntry.leaveForHome as ReturnType<typeof vi.fn>).mockImplementation(async (_ctx, promote) => {
      events.push('leave-workflow');
      await promote();
      return 'not-opened';
    });
    (workflowEntry.begin as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('begin-system-restart');
      return workflowReceipt;
    });
    (workflowEntry.markRunning as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events.push('mark-system-restart-running');
      return true;
    });

    await callbacks[0].fn(ctx);

    expect(workflowNavigation.complete).toHaveBeenCalledWith(ctx, { receipt: workflowReceipt }, expect.objectContaining({
      effectStage: 'pending',
    }));
    expect(events).toEqual([
      'leave-workflow',
      'claim-restart',
      'begin-system-restart',
      'mark-system-restart-running',
      'dispatch-restart',
      'finish-restart',
      'terminal-error',
      'restore-system',
    ]);
  });

  it('does not claim a workflow or mutate a setting after validation reports a stale callback', async () => {
    const thresholds = { execute: vi.fn() };
    const { callbacks, validate, navigation, workflowEntry } = setup({ thresholds });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'auto-clean-threshold', value: 80 }));
    ctx.localeState = localeState('admin');
    (validate.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'stale' });

    await callbacks[0].fn(ctx);

    expect(navigation.route).not.toHaveBeenCalled();
    expect(navigation.executeEffect).not.toHaveBeenCalled();
    expect(workflowEntry.leaveForHome).not.toHaveBeenCalled();
    expect(thresholds.execute).not.toHaveBeenCalled();
  });
});

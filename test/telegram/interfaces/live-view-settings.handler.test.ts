import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { GetLiveViewSettingsUseCase } from '../../../src/camera/application/get-live-view-settings.use-case';
import { ListPrivateSubnetSuggestionsUseCase } from '../../../src/camera/application/list-private-subnet-suggestions.use-case';
import { InMemoryLiveViewSettingsAdapter } from '../../../src/camera/infrastructure/in-memory-live-view-settings.adapter';
import { InMemoryLiveViewSettingsJobRepository } from '../../../src/camera/infrastructure/in-memory-live-view-settings-job.repository';
import { ClaimLiveViewSettingsMutationUseCase } from '../../../src/telegram/application/claim-live-view-settings-mutation.use-case';
import { BeginWorkflowReturnUseCase } from '../../../src/telegram/application/begin-workflow-return.use-case';
import { InMemoryHomeActionRepository } from '../../../src/telegram/infrastructure/in-memory-home-action.repository';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { LiveViewSettingsHandler } from '../../../src/telegram/interfaces/live-view-settings.handler';
import { LiveViewSettingsDraftRegistry } from '../../../src/telegram/interfaces/live-view-settings-draft.registry';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';
import { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import { WorkflowOperationQueue } from '../../../src/telegram/interfaces/workflow-operation.queue';
import { WorkflowNavigationPresenter } from '../../../src/telegram/interfaces/workflow-navigation.presenter';
import { liveViewSettingsCallback, type LiveViewSettingsCallbackAction } from '../../../src/telegram/domain/live-view-settings-callback';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';

const receipt: WorkflowReturnReceipt = {
  id: 'abcdefghijklmnop', userId: 1, chatId: 1, kind: 'workflow-return', sessionToken: null,
  status: 'pending', expiresAt: new Date(3_600_000),
  payload: { workflow: 'live-view-settings', phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'admin-tools' }, operation: { kind: 'live-view-settings-mutation', jobId: 'qrstuvwxyzabcdef', expectedGeneration: 4 }, deliveryStage: 'pending' },
};
const delivery = { userId: 1, chatId: 1, receiptId: receipt.id };

async function setup() {
  let now = 0;
  let messageId = 100;
  const clock = { now: () => new Date(now) };
  const users = new InMemoryUserRepository();
  const user = await users.createAdmin({ telegramId: 1, name: 'Admin', locale: 'en', role: 'admin', createdAt: clock.now() });
  const jobs = new InMemoryLiveViewSettingsJobRepository();
  const actions = new InMemoryHomeActionRepository(users, undefined, jobs);
  await actions.create(receipt);
  const lifecycle = new WorkflowDraftRegistry();
  const drafts = new LiveViewSettingsDraftRegistry(clock, lifecycle);
  drafts.onModuleInit();
  const workflows = new WorkflowEntryCoordinator(new BeginWorkflowReturnUseCase(actions, { generate: () => 'ZYXWVUTSRQPONMLK' }, clock), lifecycle, new WorkflowOperationQueue(), actions, clock);
  const settings = new InMemoryLiveViewSettingsAdapter({ version: 1, generation: 4, enabled: false, allowedCameraCidrs: [] });
  const attention = { read: vi.fn().mockResolvedValue(null) };
  const status = new GetLiveViewSettingsUseCase(settings, attention);
  const detector = { detect: vi.fn().mockResolvedValue(Array.from({ length: 32 }, (_, n) => ({ cidr: `10.${n}.0.0/16`, interfaceLabels: ['eth0'], interfaceLabelCount: 1 }))) };
  const suggestions = new ListPrivateSubnetSuggestionsUseCase(detector);
  const claim = new ClaimLiveViewSettingsMutationUseCase(actions, settings, clock);
  const claimSpy = vi.spyOn(claim, 'execute');
  const apply = { execute: vi.fn().mockResolvedValue({ kind: 'restart-dispatched' }) };
  const restart = { retry: vi.fn().mockResolvedValue(undefined) };
  const capability = { isAvailable: vi.fn().mockResolvedValue(true) };
  const detail = { execute: vi.fn().mockResolvedValue({ status: { name: 'rtsp', installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install', secondaryAction: null }, impact: { dependencies: 'rtsp-runtime', controls: 'live-streams', monitoring: 'camera-work', restartScope: 'worker' }, secondary: null }) };
  const dm = { send: vi.fn().mockResolvedValue(undefined) };
  const restore = { execute: vi.fn().mockResolvedValue({ kind: 'opened' }) };
  const handler = new LiveViewSettingsHandler(status, suggestions, claim, apply as never, restart as never, jobs, capability, detail as never, drafts, workflows, new WorkflowNavigationPresenter(), users, dm, restore as never);
  const reply = vi.fn().mockImplementation(async () => ({ message_id: ++messageId }));
  const ack = vi.fn().mockResolvedValue(undefined);
  const ctx = { from: { id: 1 }, chat: { id: 1, type: 'private' }, localeState: { user, locale: 'en', catalog: catalogFor('en') }, reply, answerCallbackQuery: ack } as unknown as TelegramContext;
  const callback = (action: LiveViewSettingsCallbackAction, id = messageId) => handler.onCallback({ ...ctx, callbackQuery: { data: liveViewSettingsCallback(receipt.id, action), message: { message_id: id } } } as TelegramContext);
  const text = (value: string) => handler.onText({ ...ctx, message: { text: value } } as TelegramContext);
  const screen = () => String(reply.mock.calls.at(-1)?.[0]);
  const buttons = () => (reply.mock.calls.at(-1)?.[1].reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat();
  const draft = () => { const resolved = drafts.association(1, 1); if (!resolved) throw new Error('Draft missing'); return resolved; };
  return { handler, ctx, callback, text, screen, buttons, draft, drafts, lifecycle, actions, settings, jobs, attention, capability, detail, claimSpy, apply, restart, dm, restore, users, reply, ack, clock, advance: (ms: number) => { now += ms; } };
}

describe('LiveViewSettingsHandler', () => {
  it.each([false, true])('shows configured state %s with one toggle and standard navigation', async (enabled) => {
    const s = await setup();
    s.settings.setCommitted({ version: 1, generation: 4, enabled, allowedCameraCidrs: ['192.168.1.0/24'] });
    await s.handler.handleCommand(s.ctx, { receipt });
    expect(s.screen()).toContain(enabled ? 'Enabled' : 'Disabled');
    expect(s.screen()).toContain('192.168.1.0/24');
    expect(s.buttons().filter(b => [':e', ':d'].some(code => b.callback_data.endsWith(code)))).toHaveLength(1);
    expect(s.buttons().map(b => b.callback_data)).toContain('wr:abcdefghijklmnop:o');
    expect(s.buttons().map(b => b.callback_data)).toContain('wr:abcdefghijklmnop:h');
    expect(await s.jobs.findActive()).toBeNull();
  });

  it.each(['restart', 'dependency', 'legacy', 'repair', 'busy'])('presents the %s state without claiming a mutation', async (state) => {
    const s = await setup();
    if (state === 'restart') s.settings.setCommitted({ version: 1, generation: 5, enabled: true, allowedCameraCidrs: [] });
    if (state === 'dependency') s.capability.isAvailable.mockResolvedValue(false);
    if (state === 'legacy') s.attention.read.mockResolvedValue('legacy-values-invalid');
    if (state === 'repair') vi.spyOn(s.settings, 'readCommitted').mockRejectedValue(new Error('secret raw path'));
    if (state === 'busy') s.jobs.claimPrepared({ id: 'qrstuvwxyzabcdef', expectedGeneration: 4, candidateSettings: { enabled: true, allowedCameraCidrs: [] }, requestedByUserId: 2, requestedInChatId: 2, workflowReceiptId: 'qrstuvwxyzabcdef', now: s.clock.now() });
    await s.handler.handleCommand(s.ctx, { receipt });
    const expected = { restart: 'Restart required', dependency: 'Dependencies unavailable', legacy: 'Legacy live view settings were not imported', repair: 'repair required', busy: 'Another live view change is already running' };
    expect(s.screen()).toContain(expected[state]);
    expect(s.claimSpy).not.toHaveBeenCalled();
  });

  it('reviews enable and disable without changing committed settings', async () => {
    const s = await setup();
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'enable' });
    expect(s.screen()).toContain('Enabled');
    expect(s.screen()).toContain('restart');
    expect(s.buttons().some(b => b.callback_data.endsWith(':s'))).toBe(true);
    expect((await s.settings.readCommitted()).enabled).toBe(false);
    expect(await s.jobs.findActive()).toBeNull();
  });

  it('offers eight page-local suggestions, discloses truncation and always offers manual entry', async () => {
    const s = await setup();
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'networks' });
    expect(s.buttons().filter(b => /:a[0-7]$/.test(b.callback_data))).toHaveLength(8);
    expect(s.screen()).toContain('More networks available');
    await s.callback({ kind: 'suggestion-page', page: 1 });
    expect(s.buttons().find(b => b.callback_data.endsWith(':a0'))?.text).toContain('10.8.0.0/16');
    expect(s.buttons().some(b => b.callback_data.endsWith(':m'))).toBe(true);
    await s.callback({ kind: 'add-suggestion', selector: 0 });
    expect(s.draft().candidate.allowedCameraCidrs).toEqual(['10.8.0.0/16']);
    await s.callback({ kind: 'remove-entry', selector: 0 });
    expect(s.draft().candidate.allowedCameraCidrs).toEqual([]);
  });

  it('keeps invalid input and requires explicit canonical-network confirmation', async () => {
    const s = await setup();
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'manual' });
    await s.text('8.8.8.8/32');
    expect(s.screen()).toContain('Invalid');
    await s.text('192.168.1.42/24');
    expect(s.screen()).toContain('192.168.1.42/24');
    expect(s.screen()).toContain('192.168.1.0/24');
    expect(s.draft().candidate.allowedCameraCidrs).toEqual([]);
    await s.callback({ kind: 'confirm-normalized' });
    expect(s.draft().candidate.allowedCameraCidrs).toEqual(['192.168.1.0/24']);
    expect(s.claimSpy).not.toHaveBeenCalled();
  });

  it('rejects stale screen controls, lost drafts and expiry without mutation', async () => {
    const s = await setup();
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'networks' });
    await s.callback({ kind: 'add-suggestion', selector: 0 }, 101);
    expect(s.draft().candidate.allowedCameraCidrs).toEqual([]);
    s.advance(600_000);
    await s.callback({ kind: 'save' });
    expect(s.screen()).toContain('Start again');
    await s.callback({ kind: 'save' });
    expect(s.screen()).toContain('Start again');
    expect(await s.jobs.findActive()).toBeNull();
  });

  it.each(['callback', 'text'])('rechecks persisted role on %s and deletes the draft on demotion', async (continuation) => {
    const s = await setup();
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'manual' });
    await s.users.updateRole(1, 'user');
    if (continuation === 'callback') await s.callback({ kind: 'enable' });
    else await s.text('10.0.0.0/8');
    expect(s.screen()).toContain('Admin access required');
    expect(s.drafts.resolve(delivery)).toEqual({ kind: 'missing' });
    expect(await s.jobs.findActive()).toBeNull();
  });

  it('requires an allowed network when enabled RTSP is installed', async () => {
    const s = await setup();
    s.detail.execute.mockResolvedValue({ status: { installed: true, enabled: true, ready: true } });
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'enable' });
    expect(s.screen()).toContain('RTSP requires at least one allowed network');
    expect(s.buttons().some(b => b.callback_data.endsWith(':s'))).toBe(false);
  });

  it('acknowledges before the atomic claim and returns Applying while apply is still running', async () => {
    const s = await setup();
    let finish!: (value: { kind: string }) => void;
    s.apply.execute.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'enable' });
    s.ack.mockClear();
    await s.callback({ kind: 'save' });
    expect(s.ack.mock.invocationCallOrder[0]).toBeLessThan(s.claimSpy.mock.invocationCallOrder[0]);
    const job = await s.jobs.findActive();
    expect(job?.status).toBe('prepared');
    expect(s.apply.execute).toHaveBeenCalledWith(job!.id);
    expect(s.screen()).toContain('Applying live view settings');
    await s.callback({ kind: 'save' });
    expect(s.apply.execute).toHaveBeenCalledTimes(1);
    finish({ kind: 'restart-dispatched' });
    await vi.waitFor(() => expect(s.reply.mock.calls.some(call => String(call[0]).includes('Saved — restarting'))).toBe(true));
  });

  it('discards a stale generation and reloads current settings', async () => {
    const s = await setup();
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'enable' });
    s.settings.setCommitted({ version: 1, generation: 5, enabled: false, allowedCameraCidrs: ['10.0.0.0/8'] });
    await s.callback({ kind: 'save' });
    expect(s.screen()).toContain('10.0.0.0/8');
    expect(s.draft().expectedGeneration).toBe(5);
    expect(await s.jobs.findActive()).toBeNull();
  });

  it('contains detached errors and delivers only the bounded durable failure', async () => {
    const s = await setup();
    s.apply.execute.mockImplementation(async (id: string) => {
      await s.jobs.terminalizeFailure(id, 'policy-apply-failed', s.clock.now());
      throw new Error('SECRET https://password@host/private');
    });
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'enable' });
    await s.callback({ kind: 'save' });
    await vi.waitFor(() => expect(s.dm.send).toHaveBeenCalledOnce());
    expect(s.dm.send.mock.calls[0][1]).toContain('policy');
    expect(s.dm.send.mock.calls[0][1]).not.toContain('SECRET');
  });

  it('offers restart retry for the same durable job without a second mutation', async () => {
    const s = await setup();
    s.apply.execute.mockImplementation(async (id: string) => {
      await s.jobs.markPublished(id, s.clock.now());
      await s.jobs.markCommitted(id, s.clock.now());
      await s.jobs.markRestartRequired(id, 'restart-dispatch-failed', s.clock.now());
      return { kind: 'restart-required' };
    });
    await s.handler.handleCommand(s.ctx, { receipt });
    await s.callback({ kind: 'enable' });
    await s.callback({ kind: 'save' });
    await vi.waitFor(() => expect(s.screen()).toContain('Saved — restart required'));
    const job = await s.jobs.findActive();
    await s.callback({ kind: 'retry-restart' });
    expect(s.restart.retry).toHaveBeenCalledWith(job!.id);
    expect(s.claimSpy).toHaveBeenCalledTimes(1);
  });

  it('delivers one post-boot terminal outcome through exact receipt recovery', async () => {
    const s = await setup();
    const job = await s.claimSpy({ ...delivery, jobId: 'qrstuvwxyzabcdef', expectedGeneration: 4, candidate: { enabled: true, allowedCameraCidrs: [] } });
    await s.jobs.markPublished(job.id, s.clock.now());
    await s.jobs.markCommitted(job.id, s.clock.now());
    const terminal = await s.jobs.terminalizeSuccess(job.id, s.clock.now());
    await s.handler.notify(terminal);
    await s.handler.notify(terminal);
    expect(s.dm.send).toHaveBeenCalledOnce();
    expect(s.restore.execute).toHaveBeenCalledOnce();
  });
});

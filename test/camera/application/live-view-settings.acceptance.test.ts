import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplyLiveViewSettingsUseCase } from '../../../src/camera/application/apply-live-view-settings.use-case';
import { LiveViewSettingsRecoveryService } from '../../../src/camera/application/live-view-settings-recovery.service';
import { LiveViewSettingsOutcomeRegistryService } from '../../../src/camera/application/live-view-settings-outcome-registry.service';
import { LiveViewReadinessBarrierService } from '../../../src/camera/application/live-view-readiness-barrier.service';
import { LiveViewRestartActivationService } from '../../../src/camera/application/live-view-restart-activation.service';
import { ReconcileLiveViewSettingsJobUseCase } from '../../../src/camera/application/reconcile-live-view-settings-job.use-case';
import { ReconcileRtspPolicyUseCase } from '../../../src/camera/application/reconcile-rtsp-policy.use-case';
import { LiveViewPolicyCoordinatorService } from '../../../src/camera/application/live-view-policy-coordinator.service';
import { LiveViewStartGate } from '../../../src/camera/application/live-view-start-gate.service';
import { RtspSourceStartGate } from '../../../src/camera/application/rtsp-source-start-gate.service';
import { LiveStreamSessionService } from '../../../src/camera/application/live-stream-session.service';
import { InMemoryLiveViewSettingsAdapter } from '../../../src/camera/infrastructure/in-memory-live-view-settings.adapter';
import { InMemoryLiveViewSettingsJobRepository } from '../../../src/camera/infrastructure/in-memory-live-view-settings-job.repository';
import { InMemoryLiveViewPolicyAdapter } from '../../../src/camera/infrastructure/in-memory-live-view-policy.adapter';
import { InMemoryLiveStreamGatewayAdapter } from '../../../src/camera/infrastructure/in-memory-live-stream-gateway.adapter';
import { InMemoryLiveStreamLeaseAdapter } from '../../../src/camera/infrastructure/in-memory-live-stream-lease.adapter';
import { InMemoryMonotonicClockAdapter } from '../../../src/camera/infrastructure/in-memory-monotonic-clock.adapter';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { InMemoryHomeActionRepository } from '../../../src/telegram/infrastructure/in-memory-home-action.repository';
import { ClaimLiveViewSettingsMutationUseCase } from '../../../src/telegram/application/claim-live-view-settings-mutation.use-case';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import type { LiveViewSettingsCandidate } from '../../../src/camera/domain/live-view-settings';
import type { LiveViewSettingsJob } from '../../../src/camera/domain/live-view-settings-job';
import type { ProcessRestarterPort } from '../../../src/system/domain/ports/process-restarter.port';

const now = new Date('2030-01-01T00:00:00Z');
const jobId = 'AbCdEfGhIjKlMnOp';
const receiptId = 'QrStUvWxYz012345';
const enabled = { enabled: true, allowedCameraCidrs: [] };
const poll = { maxResultPolls: 1, resultPollIntervalMs: 1, sleep: async () => undefined };

function setup(rtspEnabled = false) {
  const settings = new InMemoryLiveViewSettingsAdapter();
  const jobs = new InMemoryLiveViewSettingsJobRepository();
  const policy = new InMemoryLiveViewPolicyAdapter(settings);
  const gate = new LiveViewStartGate();
  const rtsp = new RtspSourceStartGate();
  const readiness = new LiveViewReadinessBarrierService(gate, rtsp);
  const outcomes = new LiveViewSettingsOutcomeRegistryService();
  const gateway = new InMemoryLiveStreamGatewayAdapter();
  const lease = new InMemoryLiveStreamLeaseAdapter();
  const sessions = new LiveStreamSessionService(gateway, lease, new InMemoryMonotonicClockAdapter(),
    { alert: async () => undefined }, { delete: async () => undefined }, 300_000, 100, 2, gate, rtsp);
  const restarter: ProcessRestarterPort = { restart: async (activate) => { await activate?.(); } };
  const coordinator = new LiveViewPolicyCoordinatorService();
  const activation = new LiveViewRestartActivationService(jobs, settings, gate, restarter, { now: () => now });
  const reconcile = new ReconcileLiveViewSettingsJobUseCase(jobs, settings,
    { listAll: async () => [{ name: 'rtsp', installed: true, enabled: rtspEnabled, config: null, attentionReason: null }] }, gate, sessions, coordinator, policy, policy, policy, policy,
    restarter, { isAvailable: async () => true }, { now: () => now }, poll, activation, outcomes);
  const recovery = new LiveViewSettingsRecoveryService(jobs, reconcile, settings, gate, rtsp, readiness, outcomes);
  const users = new InMemoryUserRepository([1, 2].map(telegramId => ({ telegramId, name: 'Admin', role: 'admin', locale: 'en',
    muted: false, nonCriticalPausedUntil: null, notificationPauseRevision: 0, quietStart: null, quietEnd: null, createdAt: now })));
  const actions = new InMemoryHomeActionRepository(users, undefined, jobs);
  const claim = new ClaimLiveViewSettingsMutationUseCase(actions, settings, { now: () => now });
  async function prepare(candidate: LiveViewSettingsCandidate = enabled, userId = 1) {
    const id = userId === 1 ? receiptId : 'ZaYbXcWdVeUfTgSh';
    const selectedJobId = userId === 1 ? jobId : 'BcDeFgHiJkLmNoPq';
    const receipt: WorkflowReturnReceipt = { id, userId, chatId: userId, kind: 'workflow-return', sessionToken: null,
      status: 'pending', expiresAt: new Date(now.getTime() + 60_000), payload: { workflow: 'live-view-settings',
        phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'home', checking: false },
        operation: { kind: 'live-view-settings-mutation', jobId: selectedJobId, expectedGeneration: 0 }, deliveryStage: 'pending' } };
    await actions.beginWorkflowReturn(receipt);
    return claim.execute({ userId, chatId: userId, receiptId: id, jobId: selectedJobId, expectedGeneration: 0, candidate });
  }
  return { settings, jobs, policy, gate, rtsp, readiness, outcomes, gateway, lease, sessions, restarter, activation,
    reconcile, recovery, prepare, apply: new ApplyLiveViewSettingsUseCase(reconcile) };
}

afterEach(() => vi.useRealTimers());

describe('admin live view settings acceptance', () => {
  it('enables Motion without CIDRs, commits one generation, and reports before restarting', async () => {
    const s = setup();
    const delivered: string[] = [];
    s.outcomes.register({ notify: async () => undefined, notifyPreRestart: async job => { delivered.push(job.status); } });
    await s.prepare();
    await s.apply.execute(jobId);
    expect(await s.settings.readCommitted()).toEqual({ version: 1, generation: 1, ...enabled });
    expect(await s.jobs.findById(jobId)).toMatchObject({ status: 'succeeded', activeSlot: null });
    expect(s.policy.snapshot().settingsCommitCount).toBe(1);
    expect(delivered).toEqual(['committed']);
  });

  it('requires CIDRs when enabling settings with RTSP active', async () => {
    const s = setup(true);
    await s.prepare();
    await expect(s.apply.execute(jobId)).rejects.toThrow();
    expect(await s.jobs.findById(jobId)).toMatchObject({ status: 'failed', failureCode: 'request-invalid' });
    expect(s.policy.snapshot().request).toBeNull();
  });

  it('rejects a second administrator while preserving the claimed active job', async () => {
    const s = setup();
    await s.prepare();
    await expect(s.prepare(enabled, 2)).rejects.toMatchObject({ code: 'LIVE_VIEW_SETTINGS_BUSY' });
    expect(await s.jobs.findActive()).toMatchObject({ id: jobId, requestedByUserId: 1 });
  });

  it('waits for a late converter start to stop before publishing settings', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.gate.openIfCurrent(s.gate.close());
    let release!: () => void;
    const start = s.gateway.start.bind(s.gateway);
    s.gateway.start = async () => { await new Promise<void>(resolve => { release = resolve; }); return start(); };
    const opening = s.sessions.open({ kind: 'motion-mjpeg', cameraId: 'front', cameraName: 'front',
      upstreamUrl: 'http://127.0.0.1:8081' }, 1);
    const rejected = expect(opening).rejects.toMatchObject({ code: 'LIVE_STREAM_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    await s.prepare();
    const applying = s.apply.execute(jobId);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.policy.snapshot().request).toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await applying;
    expect(s.policy.snapshot().settingsCommitCount).toBe(1);
    expect(await s.lease.read()).toBeNull();
    await s.sessions.onModuleDestroy();
  });

  it('rolls back helper start failure without publishing a new settings generation', async () => {
    const s = setup();
    await s.prepare();
    s.policy.start = async () => { throw new Error('helper unavailable'); };
    await expect(s.apply.execute(jobId)).rejects.toThrow();
    expect(await s.settings.readCommitted()).toMatchObject({ generation: 0, enabled: false });
    expect(await s.jobs.findById(jobId)).toMatchObject({ status: 'failed', failureCode: 'unit-start-failed' });
  });

  it.each(['prepared', 'published'] as const)('recovers a %s crash once and delivers the terminal job to a late listener once', async phase => {
    const s = setup();
    await s.prepare();
    if (phase === 'published') {
      await s.policy.publish({ version: 1, kind: 'settings-mutation', requestId: jobId,
        expectedGeneration: 0, rtspEnabled: false, settings: enabled });
      await s.jobs.markPublished(jobId, now);
    }
    const first = s.recovery.run();
    expect(s.recovery.run()).toBe(first);
    await first;
    const delivered: LiveViewSettingsJob[] = [];
    s.outcomes.register({ notify: async job => { delivered.push(job); }, notifyPreRestart: async () => undefined });
    await s.recovery.onApplicationBootstrap();
    await s.readiness.wait();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ id: jobId, workflowReceiptId: receiptId, status: 'succeeded' });
    expect(s.policy.snapshot().settingsCommitCount).toBe(1);
  });

  it('reconciles RTSP false/true at the same settings generation', async () => {
    const s = setup();
    s.settings.setCommitted({ version: 1, generation: 3, enabled: true, allowedCameraCidrs: ['10.0.0.0/8'] });
    const reconcile = new ReconcileRtspPolicyUseCase(s.settings, s.policy, s.policy, s.policy, s.policy, poll);
    await reconcile.execute({ rtspEnabled: false });
    await reconcile.execute({ rtspEnabled: true });
    expect(await s.settings.readCommitted()).toMatchObject({ generation: 3 });
    expect(s.policy.snapshot()).toMatchObject({ settingsCommitCount: 0, resultWriteCount: 2 });
  });

  it('retries a restart-required job and activates it through fresh recovery', async () => {
    const s = setup();
    await s.prepare();
    s.restarter.restart = async () => { throw new Error('supervisor unavailable'); };
    expect(await s.apply.execute(jobId)).toEqual({ kind: 'restart-required' });
    expect(() => s.gate.assertCanStart()).toThrow();
    s.restarter.restart = async activate => { await activate?.(); };
    await s.activation.retry(jobId);
    const reboot = setup();
    const reconcile = new ReconcileLiveViewSettingsJobUseCase(s.jobs, s.settings, { listAll: async () => [] },
      reboot.gate, reboot.sessions, new LiveViewPolicyCoordinatorService(), s.policy, s.policy, s.policy, s.policy,
      s.restarter, { isAvailable: async () => true }, { now: () => now }, poll);
    const recovery = new LiveViewSettingsRecoveryService(s.jobs, reconcile, s.settings, reboot.gate, reboot.rtsp, reboot.readiness);
    await recovery.run();
    expect(await s.jobs.findById(jobId)).toMatchObject({ status: 'succeeded', activeSlot: null });
    expect(() => reboot.gate.assertCanStart()).not.toThrow();
  });

  it('completes failed boot with both gates closed', async () => {
    const s = setup();
    s.settings.readCommitted = async () => { throw new Error('unsafe settings'); };
    await s.recovery.onApplicationBootstrap();
    await s.readiness.wait();
    expect(() => s.gate.assertCanStart()).toThrow();
    expect(s.rtsp.isOpen()).toBe(false);
  });

  it('releases boot waiters with both gates closed while a restart is still required', async () => {
    const s = setup();
    await s.prepare();
    s.restarter.restart = async () => { throw new Error('supervisor unavailable'); };
    await s.recovery.run();
    await s.readiness.wait();
    expect(() => s.gate.assertCanStart()).toThrow();
    expect(s.rtsp.isOpen()).toBe(false);
  });
});

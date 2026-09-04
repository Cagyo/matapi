import { Inject, Injectable } from '@nestjs/common';
import {
  ARCHIVE_PROVIDER_STATE_REPOSITORY,
  type ArchiveProviderBlockReason,
  type ArchiveProviderOperationClass,
  type ArchiveProviderProbeReason,
  type ArchiveProviderState,
  type ArchiveProviderStateRepositoryPort,
} from './ports/archive-provider-state-repository.port';
import { DrivePolicyBlockedError } from '../domain/errors/drive-policy-blocked.error';
import { DriveProviderCapacityBlockedError } from '../domain/errors/drive-provider-capacity-blocked.error';
import { DriveQuotaExceededError } from '../domain/errors/drive-quota-exceeded.error';
import { DriveRateLimitedError } from '../domain/errors/drive-rate-limited.error';
import { DriveReauthorizationRequiredError } from '../domain/errors/drive-reauthorization-required.error';
import { DriveTemporaryUnavailableError } from '../domain/errors/drive-temporary-unavailable.error';
import type { DriveConnectionSnapshot } from '../domain/drive-connection.entity';
import { ARCHIVE_ADMIN_ALERT_COOLDOWN_MS } from './archive-admin-alert.service';
import type {
  ArchiveAdminAlertActiveFence,
  ArchiveAdminAlertOutboxPort,
} from './ports/archive-admin-alert-outbox.port';

const RETRY_SLOTS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000] as const;
const DEFAULT_MAXIMUM_SLEEP_MS = 2 * 60 * 1_000;
const TEMPORARY_CAPACITY_MS = 60 * 60 * 1_000;
const MAX_PROVIDER_DELAY_MS = 24 * 60 * 60 * 1_000;
const QUOTA_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const QUOTA_PROBE_JITTER_MS = 60_000;

export interface ArchiveProviderGateClock { now(): Date }
export interface ArchiveProviderGateSleeper { sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface ArchiveProviderGateRandom { random(): number }
export interface ArchiveProviderGateOptions { maximumSleepMs?: number }

export interface ArchiveProviderGateActiveConnectionReader {
  loadActive(): Promise<Pick<DriveConnectionSnapshot, 'id' | 'revision' | 'status'> | null>;
}

export type ArchiveProviderAdmission =
  | { kind: 'allowed' }
  | {
    kind: 'probe';
    generationId: string;
    revision: number;
    reason: ArchiveProviderProbeReason;
    operationClass: ArchiveProviderOperationClass;
  }
  | { kind: 'cooldown'; untilMs: number }
  | { kind: 'blocked'; reason: ArchiveProviderBlockReason | 'stale_generation' };

export interface ArchiveProviderProbeClaim {
  generationId: string;
  revision: number;
  reason: ArchiveProviderProbeReason;
  operationClass: ArchiveProviderOperationClass;
}

export type ArchiveProviderImmediateResult<T> =
  | { kind: 'executed'; value: T }
  | { kind: 'denied' };

/** Durable generation-scoped admission and bounded retry policy for Drive work. */
@Injectable()
export class ArchiveProviderGateService {
  private readonly maximumSleepMs: number;

  constructor(
    @Inject(ARCHIVE_PROVIDER_STATE_REPOSITORY)
    private readonly repository: ArchiveProviderStateRepositoryPort,
    private readonly clock: ArchiveProviderGateClock = { now: () => new Date() },
    private readonly sleeper: ArchiveProviderGateSleeper = { sleep: defaultSleep },
    private readonly jitter: ArchiveProviderGateRandom = { random: Math.random },
    options: ArchiveProviderGateOptions = {},
    private readonly probeFailureSettlement?: Pick<
      ArchiveAdminAlertOutboxPort,
      'settleProviderProbeFailure'
    >,
    private readonly activeConnections?: ArchiveProviderGateActiveConnectionReader,
  ) {
    const maximumSleepMs = options.maximumSleepMs ?? DEFAULT_MAXIMUM_SLEEP_MS;
    if (!Number.isSafeInteger(maximumSleepMs) || maximumSleepMs < 1) {
      throw new Error('Archive provider maximum sleep is invalid');
    }
    this.maximumSleepMs = maximumSleepMs;
  }

  async run<T>(input: {
    generationId: string;
    operationClass: ArchiveProviderOperationClass;
    probe?: boolean;
    operation: () => Promise<T>;
    signal?: AbortSignal;
    beforeWait?: (waitMs: number) => Promise<void>;
  }): Promise<T> {
    throwIfAborted(input.signal);
    const admission = await this.inspect(input.generationId, input.operationClass);
    let expectedProviderRevision: number | null = null;
    let ownsProviderState = false;
    let probeClaim: ArchiveProviderProbeClaim | null = null;
    let probeFence: ArchiveAdminAlertActiveFence | null = null;
    if (admission.kind === 'blocked') throw blockedError(admission.reason);
    if (admission.kind === 'cooldown') {
      await this.wait(admission.untilMs, input.signal, input.beforeWait);
      if (admission.untilMs > this.nowMs()) {
        throw new DriveTemporaryUnavailableError('Drive provider cooldown is active');
      }
      return this.run(input);
    }
    if (admission.kind === 'probe') {
      if (input.probe !== true
        || admission.reason === 'quota'
        || admission.operationClass !== input.operationClass) {
        throw new DriveTemporaryUnavailableError('Drive provider recovery probe is pending');
      }
      const claim = await this.claimRecoveryProbe(admission);
      if (claim === null) {
        throw new DriveTemporaryUnavailableError('Drive provider recovery probe is pending');
      }
      expectedProviderRevision = claim.revision;
      ownsProviderState = true;
      probeClaim = claim;
      probeFence = await this.captureActiveFence(input.generationId);
    } else {
      const current = await this.loadGeneration(input.generationId);
      if (current === null || admissionFor(current, input.operationClass, this.nowMs()).kind !== 'allowed') {
        throw new DriveTemporaryUnavailableError('Drive provider admission changed');
      }
      expectedProviderRevision = current.revision;
    }

    for (let retries = 0; ; retries += 1) {
      throwIfAborted(input.signal);
      try {
        const result = await input.operation();
        if (ownsProviderState) {
          await this.recordSuccess(
            input.generationId,
            input.operationClass,
            admission.kind === 'probe',
            expectedProviderRevision,
          );
        }
        return result;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const failedProbeClaim = probeClaim;
        expectedProviderRevision = await this.recordFailureAtRevision(
          input.generationId,
          input.operationClass,
          error,
          expectedProviderRevision,
          failedProbeClaim,
          probeFence,
        );
        ownsProviderState = expectedProviderRevision !== null;
        if (expectedProviderRevision === null) {
          probeClaim = null;
          probeFence = null;
        } else if (probeClaim !== null) {
          probeClaim = { ...probeClaim, revision: expectedProviderRevision };
        }
        if (!isInlineRetryable(error, failedProbeClaim !== null)
          || retries >= RETRY_SLOTS_MS.length) throw error;
        if (expectedProviderRevision === null) throw error;
        const state = await this.loadGeneration(input.generationId);
        if (state?.revision !== expectedProviderRevision
          || state.operationClass !== input.operationClass) throw error;
        const deadline = state.cooldownUntilMs;
        if (deadline === null) throw error;
        await this.wait(deadline, input.signal, input.beforeWait);
        if (deadline > this.nowMs()) throw error;
        const resumed = await this.loadGeneration(input.generationId);
        if (resumed?.revision !== expectedProviderRevision
          || resumed.operationClass !== input.operationClass) throw error;
      }
    }
  }

  /** One provider attempt without waiting or claiming a recovery probe. */
  async runIfAllowed<T>(input: {
    generationId: string;
    operationClass: ArchiveProviderOperationClass;
    operation: () => Promise<T>;
    signal?: AbortSignal;
  }): Promise<ArchiveProviderImmediateResult<T>> {
    throwIfAborted(input.signal);
    const admission = await this.inspect(input.generationId, input.operationClass);
    if (admission.kind !== 'allowed') return { kind: 'denied' };
    const current = await this.loadGeneration(input.generationId);
    if (current === null
      || admissionFor(current, input.operationClass, this.nowMs()).kind !== 'allowed') {
      return { kind: 'denied' };
    }
    const expectedProviderRevision = current.revision;
    try {
      const value = await input.operation();
      return { kind: 'executed', value };
    } catch (error) {
      if (error instanceof Error) {
        await this.recordFailureAtRevision(
          input.generationId,
          input.operationClass,
          error,
          expectedProviderRevision,
        );
      }
      throw error;
    }
  }

  async ensureGeneration(generationId: string): Promise<ArchiveProviderState> {
    for (;;) {
      const current = await this.repository.load();
      if (current.generationId === generationId) return current;
      if (await this.repository.activateGeneration(current.revision, generationId, this.nowMs())) {
        return this.repository.load();
      }
    }
  }

  async inspect(
    generationId: string,
    operationClass: ArchiveProviderOperationClass,
  ): Promise<ArchiveProviderAdmission> {
    const state = await this.loadGeneration(generationId);
    if (state === null) return { kind: 'blocked', reason: 'stale_generation' };
    return admissionFor(state, operationClass, this.nowMs());
  }

  async claimRecoveryProbe(
    admission: Extract<ArchiveProviderAdmission, { kind: 'probe' }>,
  ): Promise<ArchiveProviderProbeClaim | null> {
    const current = await this.repository.load();
    const nowMs = this.nowMs();
    if (current.generationId !== admission.generationId
      || current.revision !== admission.revision
      || current.operationClass !== admission.operationClass
      || recoveryReason(current) !== admission.reason
      || current.cooldownUntilMs === null
      || current.cooldownUntilMs > nowMs) return null;
    const claimed = await this.repository.compareAndSet(current.revision, {
      ...withoutRevision(current),
      cooldownUntilMs: nowMs + this.maximumSleepMs,
      updatedAtMs: nowMs,
    });
    return claimed
      ? {
        generationId: admission.generationId,
        revision: admission.revision + 1,
        reason: admission.reason,
        operationClass: admission.operationClass,
      }
      : null;
  }

  async recordFailure(
    generationId: string,
    operationClass: ArchiveProviderOperationClass,
    error: Error,
  ): Promise<void> {
    await this.recordFailureAtRevision(generationId, operationClass, error, null);
  }

  private async recordFailureAtRevision(
    generationId: string,
    operationClass: ArchiveProviderOperationClass,
    error: Error,
    expectedRevision: number | null,
    probeClaim: ArchiveProviderProbeClaim | null = null,
    probeFence: ArchiveAdminAlertActiveFence | null = null,
  ): Promise<number | null> {
    for (;;) {
      const current = await this.loadGeneration(generationId);
      if (current === null) return null;
      if (expectedRevision !== null && current.revision !== expectedRevision) return null;
      const nowMs = this.nowMs();
      const classified = classifyFailure(error, current.failureStreak, nowMs, this.jitter);
      if (classified === null) return null;
      if (probeClaim === null
        && preservesOtherOperationAdmission(current, operationClass, classified)) return null;
      const next: Omit<ArchiveProviderState, 'revision'> = {
        generationId,
        operationClass,
        failureClass: classified.failureClass,
        failureStreak: current.failureStreak + 1,
        cooldownUntilMs: probeClaim !== null && classified.failureClass === 'quota'
          ? quotaProbeDeadline(nowMs, this.jitter)
          : classified.cooldownUntilMs,
        blockReason: probeClaim !== null && classified.failureClass === 'quota'
          ? 'quota_exhausted'
          : classified.blockReason,
        updatedAtMs: nowMs,
      };
      const probeAlertKind = probeFailureAlertKind(next.blockReason);
      if (probeClaim !== null && probeAlertKind !== null) {
        if (expectedRevision !== probeClaim.revision
          || probeFence?.id !== generationId
          || this.probeFailureSettlement === undefined) return null;
        const outcome = await this.probeFailureSettlement.settleProviderProbeFailure({
          fence: probeFence,
          expectedProviderRevision: probeClaim.revision,
          nextProviderState: next,
          alertKind: probeAlertKind,
          nowMs,
          alertCooldownUntilMs: nowMs + ARCHIVE_ADMIN_ALERT_COOLDOWN_MS,
        });
        return outcome === 'settled' ? probeClaim.revision + 1 : null;
      }
      if (await this.repository.compareAndSet(current.revision, next)) return current.revision + 1;
      if (expectedRevision !== null) return null;
    }
  }

  async recordSuccess(
    generationId: string,
    operationClass: ArchiveProviderOperationClass,
    _postCooldownProbe: boolean,
    expectedRevision?: number | null,
  ): Promise<void> {
    if (expectedRevision === undefined || expectedRevision === null) return;
    const current = await this.loadGeneration(generationId);
    if (current?.revision !== expectedRevision
      || current.operationClass !== operationClass
      || isClear(current)) return;
    await this.repository.compareAndSet(
      expectedRevision,
      clearState(generationId, this.nowMs()),
    );
  }

  async recordQuotaOutcome(
    generationId: string,
    remainingDeficitBytes: number,
    claim?: ArchiveProviderProbeClaim,
    fence?: ArchiveAdminAlertActiveFence,
  ): Promise<void> {
    if (!Number.isSafeInteger(remainingDeficitBytes) || remainingDeficitBytes < 0) {
      throw new Error('Drive quota deficit is invalid');
    }
    const current = await this.loadGeneration(generationId);
    if (current === null) return;
    const isClaimedQuotaProbe = claim?.generationId === generationId
      && claim.reason === 'quota'
      && claim.revision === current.revision
      && claim.operationClass === current.operationClass
      && current.blockReason === 'quota_exhausted';
    const isInitialQuotaClassification = claim === undefined
      && current.failureClass === 'quota'
      && current.blockReason === null;
    if (!isClaimedQuotaProbe && !isInitialQuotaClassification) return;
    const nowMs = this.nowMs();
    const next = remainingDeficitBytes === 0
      ? clearState(generationId, nowMs)
      : {
        generationId,
        operationClass: current.operationClass ?? 'delete' as const,
        failureClass: 'quota' as const,
        failureStreak: Math.max(1, current.failureStreak),
        cooldownUntilMs: quotaProbeDeadline(nowMs, this.jitter),
        blockReason: 'quota_exhausted' as const,
        updatedAtMs: nowMs,
      };
    if (isClaimedQuotaProbe && remainingDeficitBytes > 0) {
      if (fence?.id !== generationId
        || this.probeFailureSettlement === undefined) return;
      await this.probeFailureSettlement.settleProviderProbeFailure({
        fence,
        expectedProviderRevision: claim.revision,
        nextProviderState: next,
        alertKind: 'quota-reclamation-required',
        nowMs,
        alertCooldownUntilMs: nowMs + ARCHIVE_ADMIN_ALERT_COOLDOWN_MS,
      });
      return;
    }
    await this.repository.compareAndSet(current.revision, next);
  }

  private async wait(
    deadlineMs: number,
    signal?: AbortSignal,
    beforeWait?: (waitMs: number) => Promise<void>,
  ): Promise<void> {
    throwIfAborted(signal);
    const waitMs = Math.min(this.maximumSleepMs, Math.max(0, deadlineMs - this.nowMs()));
    await beforeWait?.(waitMs);
    await this.sleeper.sleep(waitMs, signal);
    throwIfAborted(signal);
  }

  private nowMs(): number {
    const value = this.clock.now().getTime();
    if (!Number.isFinite(value)) throw new Error('Archive provider clock is invalid');
    return Math.max(0, Math.floor(value));
  }

  private async loadGeneration(generationId: string): Promise<ArchiveProviderState | null> {
    const current = await this.repository.load();
    return current.generationId === generationId ? current : null;
  }

  private async captureActiveFence(
    generationId: string,
  ): Promise<ArchiveAdminAlertActiveFence | null> {
    if (this.activeConnections === undefined) return null;
    const active = await this.activeConnections.loadActive();
    if (active?.id !== generationId
      || !Number.isSafeInteger(active.revision)
      || active.revision < 0
      || (active.status !== 'active' && active.status !== 'reauth_required')) return null;
    return { id: active.id, revision: active.revision, status: active.status };
  }
}

function classifyFailure(
  error: Error,
  failureStreak: number,
  nowMs: number,
  jitter: ArchiveProviderGateRandom,
): {
  failureClass: ArchiveProviderState['failureClass'];
  cooldownUntilMs: number | null;
  blockReason: ArchiveProviderState['blockReason'];
} | null {
  if (error instanceof DriveQuotaExceededError) {
    return { failureClass: 'quota', cooldownUntilMs: null, blockReason: null };
  }
  if (error instanceof DriveProviderCapacityBlockedError) {
    if (error.kind === 'user-action') {
      return { failureClass: 'capacity', cooldownUntilMs: null, blockReason: 'account_creation_limit' };
    }
    const delay = boundedProviderDelay(error.retryAfterMs) ?? TEMPORARY_CAPACITY_MS;
    return { failureClass: 'capacity', cooldownUntilMs: nowMs + delay, blockReason: null };
  }
  if (error instanceof DrivePolicyBlockedError) {
    return { failureClass: 'policy', cooldownUntilMs: null, blockReason: 'policy_blocked' };
  }
  if (error instanceof DriveReauthorizationRequiredError) {
    return { failureClass: 'authorization', cooldownUntilMs: null, blockReason: 'reauthorization_required' };
  }
  if (error instanceof DriveRateLimitedError) {
    const supplied = boundedProviderDelay(error.detail.retryAfterMs);
    const delay = supplied ?? retryDelay(failureStreak, jitter);
    return { failureClass: 'rate-limit', cooldownUntilMs: nowMs + delay, blockReason: null };
  }
  if (error instanceof DriveTemporaryUnavailableError) {
    return { failureClass: 'transport', cooldownUntilMs: nowMs + retryDelay(failureStreak, jitter), blockReason: null };
  }
  return null;
}

function probeFailureAlertKind(
  blockReason: ArchiveProviderState['blockReason'],
): 'quota-reclamation-required' | 'provider-capacity-blocked' | 'policy-rejected' | null {
  if (blockReason === 'quota_exhausted') return 'quota-reclamation-required';
  if (blockReason === 'account_creation_limit') return 'provider-capacity-blocked';
  if (blockReason === 'policy_blocked') return 'policy-rejected';
  return null;
}

function retryDelay(failureStreak: number, jitter: ArchiveProviderGateRandom): number {
  const slot = RETRY_SLOTS_MS[Math.min(failureStreak, RETRY_SLOTS_MS.length - 1)];
  const random = jitter.random();
  const normalized = Number.isFinite(random) ? Math.max(0, Math.min(random, 0.999999999)) : 0;
  return slot + Math.floor(normalized * 1_000);
}

function boundedProviderDelay(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_PROVIDER_DELAY_MS)
    : null;
}

function admissionFor(
  state: ArchiveProviderState,
  requestedOperationClass: ArchiveProviderOperationClass,
  nowMs: number,
): ArchiveProviderAdmission {
  const probeReason = recoveryReason(state);
  if (state.blockReason !== null) {
    if (probeReason !== null
      && state.cooldownUntilMs !== null
      && state.cooldownUntilMs <= nowMs) {
      return {
        kind: 'probe',
        generationId: state.generationId!,
        revision: state.revision,
        reason: probeReason,
        operationClass: state.operationClass ?? requestedOperationClass,
      };
    }
    return { kind: 'blocked', reason: state.blockReason };
  }
  if (state.failureClass === 'quota') return { kind: 'allowed' };
  if (state.cooldownUntilMs === null) return { kind: 'allowed' };
  if (state.cooldownUntilMs > nowMs) {
    return { kind: 'cooldown', untilMs: state.cooldownUntilMs };
  }
  return {
    kind: 'probe',
    generationId: state.generationId!,
    revision: state.revision,
    reason: 'cooldown',
    operationClass: state.operationClass ?? requestedOperationClass,
  };
}

function recoveryReason(state: ArchiveProviderState): ArchiveProviderProbeReason | null {
  if (state.blockReason === 'quota_exhausted') return 'quota';
  if (state.blockReason === 'account_creation_limit') return 'capacity';
  if (state.blockReason === 'policy_blocked') return 'policy';
  if (state.blockReason !== null) return null;
  return state.cooldownUntilMs === null ? null : 'cooldown';
}

function quotaProbeDeadline(nowMs: number, jitter: ArchiveProviderGateRandom): number {
  const random = jitter.random();
  const normalized = Number.isFinite(random)
    ? Math.max(0, Math.min(random, 0.999999999))
    : 0;
  return nowMs + QUOTA_PROBE_INTERVAL_MS - Math.floor(normalized * QUOTA_PROBE_JITTER_MS);
}

function clearState(generationId: string, nowMs: number): Omit<ArchiveProviderState, 'revision'> {
  return {
    generationId, operationClass: null, failureClass: null, failureStreak: 0,
    cooldownUntilMs: null, blockReason: null, updatedAtMs: nowMs,
  };
}

function withoutRevision(state: ArchiveProviderState): Omit<ArchiveProviderState, 'revision'> {
  const { revision: _revision, ...rest } = state;
  return rest;
}

function isClear(state: ArchiveProviderState): boolean {
  return state.operationClass === null && state.failureClass === null && state.failureStreak === 0
    && state.cooldownUntilMs === null && state.blockReason === null;
}

function preservesOtherOperationAdmission(
  current: ArchiveProviderState,
  operationClass: ArchiveProviderOperationClass,
  incoming: Pick<ArchiveProviderState, 'blockReason'>,
): boolean {
  if (incoming.blockReason !== null) return false;
  if (current.blockReason !== null) return true;
  return current.operationClass !== null
    && current.operationClass !== operationClass
    && current.cooldownUntilMs !== null;
}

function isInlineRetryable(error: Error, claimedRecoveryProbe: boolean): boolean {
  if (error instanceof DriveProviderCapacityBlockedError) {
    return claimedRecoveryProbe
      && error.kind === 'temporary'
      && error.retryAfterMs !== null;
  }
  if (error instanceof DriveRateLimitedError) return error.detail.sessionUsable;
  return error instanceof DriveTemporaryUnavailableError;
}

function blockedError(reason: ArchiveProviderBlockReason | 'stale_generation'): Error {
  if (reason === 'account_creation_limit') return new DriveProviderCapacityBlockedError('user-action');
  if (reason === 'policy_blocked') return new DrivePolicyBlockedError();
  if (reason === 'reauthorization_required') return new DriveReauthorizationRequiredError();
  if (reason === 'quota_exhausted') return new DriveQuotaExceededError();
  return new DriveTemporaryUnavailableError('Drive provider work is blocked');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(abortReason(signal)); return; }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

import { Inject, Injectable } from '@nestjs/common';
import {
  ARCHIVE_PROVIDER_STATE_REPOSITORY,
  type ArchiveProviderOperationClass,
  type ArchiveProviderState,
  type ArchiveProviderStateRepositoryPort,
} from './ports/archive-provider-state-repository.port';
import { DrivePolicyBlockedError } from '../domain/errors/drive-policy-blocked.error';
import { DriveProviderCapacityBlockedError } from '../domain/errors/drive-provider-capacity-blocked.error';
import { DriveQuotaExceededError } from '../domain/errors/drive-quota-exceeded.error';
import { DriveRateLimitedError } from '../domain/errors/drive-rate-limited.error';
import { DriveReauthorizationRequiredError } from '../domain/errors/drive-reauthorization-required.error';
import { DriveTemporaryUnavailableError } from '../domain/errors/drive-temporary-unavailable.error';

const RETRY_SLOTS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000] as const;
const DEFAULT_MAXIMUM_SLEEP_MS = 2 * 60 * 1_000;
const TEMPORARY_CAPACITY_MS = 60 * 60 * 1_000;
const MAX_PROVIDER_DELAY_MS = 24 * 60 * 60 * 1_000;

export interface ArchiveProviderGateClock { now(): Date }
export interface ArchiveProviderGateSleeper { sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface ArchiveProviderGateRandom { random(): number }
export interface ArchiveProviderGateOptions { maximumSleepMs?: number }

export type ArchiveProviderAdmission =
  | { kind: 'allowed' }
  | { kind: 'probe' }
  | { kind: 'cooldown'; untilMs: number }
  | { kind: 'blocked'; reason: string };

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
    if (admission.kind === 'blocked') throw blockedError(admission.reason);
    if (admission.kind === 'cooldown') {
      await this.wait(admission.untilMs, input.signal, input.beforeWait);
      if (admission.untilMs > this.nowMs()) {
        throw new DriveTemporaryUnavailableError('Drive provider cooldown is active');
      }
      return this.run(input);
    }
    if (admission.kind === 'probe') {
      if (input.probe !== true || !(await this.claimProbe(input.generationId))) {
        throw new DriveTemporaryUnavailableError('Drive provider recovery probe is pending');
      }
    }

    for (let retries = 0; ; retries += 1) {
      throwIfAborted(input.signal);
      try {
        const result = await input.operation();
        await this.recordSuccess(input.generationId, input.operationClass, admission.kind === 'probe');
        return result;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        await this.recordFailure(input.generationId, input.operationClass, error);
        if (!isInlineRetryable(error) || retries >= RETRY_SLOTS_MS.length) throw error;
        const state = await this.ensureGeneration(input.generationId);
        const deadline = state.cooldownUntilMs;
        if (deadline === null) throw error;
        await this.wait(deadline, input.signal, input.beforeWait);
        if (error instanceof DriveRateLimitedError
          && error.detail.retryAfterMs !== null
          && deadline > this.nowMs()) {
          throw error;
        }
      }
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
    _operationClass: ArchiveProviderOperationClass,
  ): Promise<ArchiveProviderAdmission> {
    const state = await this.ensureGeneration(generationId);
    if (state.blockReason !== null) return { kind: 'blocked', reason: state.blockReason };
    if (state.failureClass === 'quota') return { kind: 'allowed' };
    if (state.cooldownUntilMs === null) return { kind: 'allowed' };
    return state.cooldownUntilMs > this.nowMs()
      ? { kind: 'cooldown', untilMs: state.cooldownUntilMs }
      : { kind: 'probe' };
  }

  async recordFailure(
    generationId: string,
    operationClass: ArchiveProviderOperationClass,
    error: Error,
  ): Promise<void> {
    for (;;) {
      const current = await this.ensureGeneration(generationId);
      const nowMs = this.nowMs();
      const classified = classifyFailure(error, current.failureStreak, nowMs, this.jitter);
      if (classified === null) return;
      const next: Omit<ArchiveProviderState, 'revision'> = {
        generationId,
        operationClass,
        failureClass: classified.failureClass,
        failureStreak: current.failureStreak + 1,
        cooldownUntilMs: classified.cooldownUntilMs,
        blockReason: classified.blockReason,
        updatedAtMs: nowMs,
      };
      if (await this.repository.compareAndSet(current.revision, next)) return;
    }
  }

  async recordSuccess(
    generationId: string,
    operationClass: ArchiveProviderOperationClass,
    postCooldownProbe: boolean,
  ): Promise<void> {
    for (;;) {
      const current = await this.ensureGeneration(generationId);
      if (!postCooldownProbe && current.operationClass !== operationClass) return;
      if (isClear(current)) return;
      if (await this.repository.compareAndSet(current.revision, clearState(generationId, this.nowMs()))) return;
    }
  }

  async recordQuotaOutcome(generationId: string, remainingDeficitBytes: number): Promise<void> {
    if (!Number.isSafeInteger(remainingDeficitBytes) || remainingDeficitBytes < 0) {
      throw new Error('Drive quota deficit is invalid');
    }
    for (;;) {
      const current = await this.ensureGeneration(generationId);
      const next = remainingDeficitBytes === 0
        ? clearState(generationId, this.nowMs())
        : {
          generationId,
          operationClass: current.operationClass ?? 'delete' as const,
          failureClass: 'quota' as const,
          failureStreak: Math.max(1, current.failureStreak),
          cooldownUntilMs: null,
          blockReason: 'quota_exhausted',
          updatedAtMs: this.nowMs(),
        };
      if (await this.repository.compareAndSet(current.revision, next)) return;
    }
  }

  private async claimProbe(generationId: string): Promise<boolean> {
    for (;;) {
      const current = await this.ensureGeneration(generationId);
      if (current.blockReason !== null || current.cooldownUntilMs === null || current.cooldownUntilMs > this.nowMs()) return false;
      const next = {
        ...withoutRevision(current),
        cooldownUntilMs: this.nowMs() + this.maximumSleepMs,
        updatedAtMs: this.nowMs(),
      };
      if (await this.repository.compareAndSet(current.revision, next)) return true;
    }
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
}

function classifyFailure(
  error: Error,
  failureStreak: number,
  nowMs: number,
  jitter: ArchiveProviderGateRandom,
): { failureClass: ArchiveProviderState['failureClass']; cooldownUntilMs: number | null; blockReason: string | null } | null {
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

function isInlineRetryable(error: Error): boolean {
  if (error instanceof DriveProviderCapacityBlockedError) return false;
  if (error instanceof DriveRateLimitedError) return error.detail.sessionUsable;
  return error instanceof DriveTemporaryUnavailableError;
}

function blockedError(reason: string): Error {
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
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortReason(signal)); }, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

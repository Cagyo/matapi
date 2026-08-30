import type {
  ArchiveProviderState,
  ArchiveProviderStateRepositoryPort,
  ArchiveProviderStateTransactionPort,
} from '../../application/ports/archive-provider-state-repository.port';

/** Deterministic in-memory parity adapter for provider-wide gate state. */
export class InMemoryArchiveProviderStateRepository implements
  ArchiveProviderStateRepositoryPort,
  ArchiveProviderStateTransactionPort {
  private state: ArchiveProviderState = emptyState();
  private stateTail: Promise<void> = Promise.resolve();
  private readonly transactionState: ArchiveProviderStateRepositoryPort = {
    load: async () => clone(this.state),
    activateGeneration: async (expectedRevision, generationId, nowMs) =>
      this.activateGenerationUnlocked(expectedRevision, generationId, nowMs),
    compareAndSet: async (expectedRevision, next) =>
      this.compareAndSetUnlocked(expectedRevision, next),
    requestProbe: async (input) => this.requestProbeUnlocked(input),
  };

  load(): Promise<ArchiveProviderState> {
    return this.withArchiveProviderStateTransaction((state) => state.load());
  }

  activateGeneration(expectedRevision: number, generationId: string, nowMs: number): Promise<boolean> {
    return this.withArchiveProviderStateTransaction(
      (state) => state.activateGeneration(expectedRevision, generationId, nowMs),
    );
  }

  compareAndSet(
    expectedRevision: number,
    next: Omit<ArchiveProviderState, 'revision'>,
  ): Promise<boolean> {
    return this.withArchiveProviderStateTransaction(
      (state) => state.compareAndSet(expectedRevision, next),
    );
  }

  requestProbe(input: {
    generationId: string;
    expectedRevision: number;
    allowedBlockReasons: readonly ('account_creation_limit' | 'policy_blocked')[];
    nowMs: number;
  }): Promise<boolean> {
    return this.withArchiveProviderStateTransaction((state) => state.requestProbe(input));
  }

  withArchiveProviderStateTransaction<T>(
    operation: (state: ArchiveProviderStateRepositoryPort) => Promise<T>,
  ): Promise<T> {
    const turn = this.stateTail.then(async () => {
      const before = this.state;
      try {
        return await operation(this.transactionState);
      } catch (error) {
        this.state = before;
        throw error;
      }
    });
    this.stateTail = turn.then(() => undefined, () => undefined);
    return turn;
  }

  private activateGenerationUnlocked(
    expectedRevision: number,
    generationId: string,
    nowMs: number,
  ): boolean {
    if (this.state.revision !== expectedRevision) return false;
    this.state = freeze({ ...emptyState(), revision: expectedRevision + 1, generationId, updatedAtMs: nowMs });
    return true;
  }

  private compareAndSetUnlocked(
    expectedRevision: number,
    next: Omit<ArchiveProviderState, 'revision'>,
  ): boolean {
    if (this.state.revision !== expectedRevision) return false;
    this.state = freeze({ ...next, revision: expectedRevision + 1 });
    return true;
  }

  private requestProbeUnlocked(input: {
    generationId: string;
    expectedRevision: number;
    allowedBlockReasons: readonly ('account_creation_limit' | 'policy_blocked')[];
    nowMs: number;
  }): boolean {
    if (this.state.generationId !== input.generationId
      || this.state.revision !== input.expectedRevision
      || this.state.cooldownUntilMs !== null
      || this.state.blockReason === null
      || !input.allowedBlockReasons.includes(this.state.blockReason as 'account_creation_limit' | 'policy_blocked')) {
      return false;
    }
    this.state = freeze({
      ...this.state,
      revision: input.expectedRevision + 1,
      cooldownUntilMs: input.nowMs,
      updatedAtMs: input.nowMs,
    });
    return true;
  }
}

function emptyState(): ArchiveProviderState {
  return freeze({
    revision: 0,
    generationId: null,
    operationClass: null,
    failureClass: null,
    failureStreak: 0,
    cooldownUntilMs: null,
    blockReason: null,
    updatedAtMs: 0,
  });
}

function clone(state: ArchiveProviderState): ArchiveProviderState {
  return freeze({ ...state });
}

function freeze(state: ArchiveProviderState): ArchiveProviderState {
  return Object.freeze(state);
}

import type {
  ArchiveProviderState,
  ArchiveProviderStateRepositoryPort,
} from '../../application/ports/archive-provider-state-repository.port';

/** Deterministic in-memory parity adapter for provider-wide gate state. */
export class InMemoryArchiveProviderStateRepository implements ArchiveProviderStateRepositoryPort {
  private state: ArchiveProviderState = emptyState();

  async load(): Promise<ArchiveProviderState> {
    return clone(this.state);
  }

  async activateGeneration(expectedRevision: number, generationId: string, nowMs: number): Promise<boolean> {
    if (this.state.revision !== expectedRevision) return false;
    this.state = freeze({ ...emptyState(), revision: expectedRevision + 1, generationId, updatedAtMs: nowMs });
    return true;
  }

  async compareAndSet(expectedRevision: number, next: Omit<ArchiveProviderState, 'revision'>): Promise<boolean> {
    if (this.state.revision !== expectedRevision) return false;
    this.state = freeze({ ...next, revision: expectedRevision + 1 });
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

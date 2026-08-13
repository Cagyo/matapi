import { describe, expect, it } from 'vitest';
import { InMemoryArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-provider-state.repository';

describe('InMemoryArchiveProviderStateRepository', () => {
  it('replaces stale generation state before admitting provider work', async () => {
    const repository = new InMemoryArchiveProviderStateRepository();
    const initial = await repository.load();
    expect(await repository.activateGeneration(initial.revision, 'generation-2', 100)).toBe(true);
    expect(await repository.load()).toMatchObject({
      generationId: 'generation-2', failureClass: null, failureStreak: 0,
      cooldownUntilMs: null, blockReason: null,
    });
  });

  it('uses revisions for atomic state changes and returns immutable snapshots', async () => {
    const repository = new InMemoryArchiveProviderStateRepository();
    const initial = await repository.load();
    expect(await repository.compareAndSet(initial.revision + 1, { ...initial, generationId: 'generation-1', updatedAtMs: 10 })).toBe(false);
    expect(await repository.load()).toEqual(initial);
    expect(await repository.compareAndSet(initial.revision, { ...initial, generationId: 'generation-1', updatedAtMs: 10 })).toBe(true);
    const stored = await repository.load();
    expect(stored).toMatchObject({ revision: 1, generationId: 'generation-1', updatedAtMs: 10 });
    expect(() => { (stored as { generationId: string | null }).generationId = 'mutated'; }).toThrow();
  });

  it('does not change state when generation activation loses its CAS', async () => {
    const repository = new InMemoryArchiveProviderStateRepository();
    expect(await repository.activateGeneration(1, 'generation-2', 100)).toBe(false);
    expect(await repository.load()).toMatchObject({ revision: 0, generationId: null, updatedAtMs: 0 });
  });
});

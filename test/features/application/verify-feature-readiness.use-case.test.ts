import { describe, expect, it } from 'vitest';
import { VerifyFeatureReadinessUseCase } from '../../../src/features/application/verify-feature-readiness.use-case';
import { FeatureVerificationError } from '../../../src/features/domain/errors/feature-verification.error';
import { InMemoryFeatureReadinessAdapter } from '../../../src/features/infrastructure/in-memory-feature-readiness.adapter';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';

describe('VerifyFeatureReadinessUseCase', () => {
  it('clears attention only when application-visible readiness succeeds', async () => {
    const features = new InMemoryFeatureRepository([{ name: 'digital', installed: true, enabled: true, config: null, attentionReason: 'readiness-failed' }]);
    const readiness = new InMemoryFeatureReadinessAdapter();
    readiness.set('digital', { ready: true, restartScope: 'worker' });

    await new VerifyFeatureReadinessUseCase(features, readiness).execute({ name: 'digital', source: 'manual' });

    expect((await features.findByName('digital'))?.attentionReason).toBeNull();
  });

  it('marks only the failed feature and leaves unrelated availability intact', async () => {
    const features = new InMemoryFeatureRepository([
      { name: 'motion', installed: true, enabled: true, config: null, attentionReason: null },
      { name: 'digital', installed: true, enabled: true, config: null, attentionReason: null },
    ]);
    const readiness = new InMemoryFeatureReadinessAdapter();
    readiness.set('motion', { ready: false, failureCode: 'application-verification-failed' });
    const useCase = new VerifyFeatureReadinessUseCase(features, readiness);

    await expect(useCase.execute({ name: 'motion', source: 'manual' })).rejects.toBeInstanceOf(FeatureVerificationError);
    expect((await features.findByName('motion'))?.attentionReason).toBe('readiness-failed');
    expect((await features.findByName('digital'))?.attentionReason).toBeNull();
  });

  it('does not persist a post-install probe result', async () => {
    const features = new InMemoryFeatureRepository([{ name: 'uart', installed: false, enabled: false, config: null, attentionReason: null }]);
    const readiness = new InMemoryFeatureReadinessAdapter();
    readiness.set('uart', { ready: false, failureCode: 'application-verification-failed' });

    const result = await new VerifyFeatureReadinessUseCase(features, readiness).execute({ name: 'uart', source: 'post-install' });

    expect(result).toEqual({ ready: false, failureCode: 'application-verification-failed' });
    expect(await features.findByName('uart')).toMatchObject({ attentionReason: null });
  });
});

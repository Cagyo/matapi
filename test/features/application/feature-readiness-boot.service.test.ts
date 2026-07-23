import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { FeatureReadinessBootService } from '../../../src/features/application/feature-readiness-boot.service';
import { FeatureAvailabilityService } from '../../../src/features/application/feature-availability.service';
import { InMemoryFeatureInstallJobRepository } from '../../../src/features/infrastructure/in-memory-feature-install-job.repository';
import { InMemoryFeatureReadinessAdapter } from '../../../src/features/infrastructure/in-memory-feature-readiness.adapter';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';
import { InMemoryFeatureQuery } from '../../../src/features/infrastructure/in-memory-feature.query';
import { VerifyFeatureReadinessUseCase } from '../../../src/features/application/verify-feature-readiness.use-case';

describe('FeatureReadinessBootService', () => {
  it('shares one initial verification pass among concurrent callers', async () => {
    const features = new InMemoryFeatureRepository([{ name: 'digital', installed: true, enabled: true, config: null, attentionReason: null }]);
    const readiness = new InMemoryFeatureReadinessAdapter();
    const verify = new VerifyFeatureReadinessUseCase(features, readiness);
    const execute = vi.spyOn(verify, 'execute');
    const boot = new FeatureReadinessBootService(new InMemoryFeatureQuery([{ name: 'digital', installed: true, enabled: true, config: null, attentionReason: null }]), verify);

    await Promise.all([boot.awaitInitialVerification(), boot.awaitInitialVerification(), boot.onApplicationBootstrap()]);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('makes inspect and requireReady wait for initial verification to settle', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const features = new InMemoryFeatureRepository([{ name: 'digital', installed: true, enabled: true, config: null, attentionReason: null }]);
    const readiness = { verify: vi.fn(async () => { await pending; return { ready: true as const, restartScope: 'worker' as const }; }) };
    const boot = new FeatureReadinessBootService(new InMemoryFeatureQuery([{ name: 'digital', installed: true, enabled: true, config: null, attentionReason: null }]), new VerifyFeatureReadinessUseCase(features, readiness));
    const availability = new FeatureAvailabilityService(features, new InMemoryFeatureInstallJobRepository(features), boot);
    const inspect = availability.inspect('digital');
    const required = availability.requireReady('digital');
    await Promise.resolve();
    expect(readiness.verify).toHaveBeenCalledTimes(1);
    release();
    await expect(inspect).resolves.toMatchObject({ ready: true });
    await expect(required).resolves.toBeUndefined();
  });

  it('continues boot verification after one feature fails', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const features = new InMemoryFeatureRepository([
      { name: 'digital', installed: true, enabled: true, config: null, attentionReason: null },
      { name: 'motion', installed: true, enabled: true, config: null, attentionReason: null },
    ]);
    const readiness = new InMemoryFeatureReadinessAdapter();
    readiness.set('motion', { ready: false, failureCode: 'application-verification-failed' });
    const verify = new VerifyFeatureReadinessUseCase(features, readiness);
    const boot = new FeatureReadinessBootService(new InMemoryFeatureQuery([
      { name: 'digital', installed: true, enabled: true, config: null, attentionReason: null },
      { name: 'motion', installed: true, enabled: true, config: null, attentionReason: null },
    ]), verify);

    await boot.onApplicationBootstrap();

    expect((await features.findByName('digital'))?.attentionReason).toBeNull();
    expect((await features.findByName('motion'))?.attentionReason).toBe('readiness-failed');
  });
});

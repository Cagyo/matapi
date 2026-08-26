import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { FeatureReadinessBootService } from '../../../src/features/application/feature-readiness-boot.service';
import { FeatureAvailabilityService } from '../../../src/features/application/feature-availability.service';
import { InMemoryFeatureInstallJobRepository } from '../../../src/features/infrastructure/in-memory-feature-install-job.repository';
import { InMemoryFeatureReadinessAdapter } from '../../../src/features/infrastructure/in-memory-feature-readiness.adapter';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';
import { InMemoryFeatureQuery } from '../../../src/features/infrastructure/in-memory-feature.query';
import { VerifyFeatureReadinessUseCase } from '../../../src/features/application/verify-feature-readiness.use-case';
import type { FeatureReadinessBarrierPort } from '../../../src/features/domain/ports/feature-readiness-barrier.port';
import type { Feature } from '../../../src/features/domain/feature.entity';
import type { FeatureQueryPort } from '../../../src/features/domain/ports/feature-query.port';

const DIGITAL: Feature = { name: 'digital', installed: true, enabled: true, config: null, attentionReason: null };

/** A `FeatureQueryPort` whose read fails, standing in for an unreadable database. */
function failingQuery(error: Error): FeatureQueryPort {
  return { listAll: () => Promise.reject(error) };
}

function loggerErrorSpy(boot: FeatureReadinessBootService): ReturnType<typeof vi.spyOn> {
  const logger = (boot as unknown as {
    logger: { error: (message: string) => void };
  }).logger;
  return vi.spyOn(logger, 'error').mockImplementation(() => undefined);
}

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
    const barrier: FeatureReadinessBarrierPort = {
      awaitInitialVerification: () => boot.awaitInitialVerification(),
    };
    const availability = new FeatureAvailabilityService(features, new InMemoryFeatureInstallJobRepository(features), barrier);
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
    readiness.set('motion', { ready: false, failureCode: 'application-verification-failed', reason: 'runtime-invalid' });
    const verify = new VerifyFeatureReadinessUseCase(features, readiness);
    const boot = new FeatureReadinessBootService(new InMemoryFeatureQuery([
      { name: 'digital', installed: true, enabled: true, config: null, attentionReason: null },
      { name: 'motion', installed: true, enabled: true, config: null, attentionReason: null },
    ]), verify);

    await boot.onApplicationBootstrap();

    expect((await features.findByName('digital'))?.attentionReason).toBeNull();
    expect((await features.findByName('motion'))?.attentionReason).toBe('readiness-failed');
  });

  it('resolves the readiness barrier when the feature listing fails', async () => {
    const verify = new VerifyFeatureReadinessUseCase(
      new InMemoryFeatureRepository([DIGITAL]), new InMemoryFeatureReadinessAdapter(),
    );
    const execute = vi.spyOn(verify, 'execute');
    const boot = new FeatureReadinessBootService(
      failingQuery(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })), verify,
    );
    const error = loggerErrorSpy(boot);

    await expect(boot.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(boot.awaitInitialVerification()).resolves.toBeUndefined();

    expect(execute).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Feature readiness verification skipped: SQLITE_BUSY');
    expect(error.mock.calls.flat().join(' ')).not.toContain('database is locked');
  });

  it('lets feature availability proceed after the feature listing fails', async () => {
    const features = new InMemoryFeatureRepository([DIGITAL]);
    const boot = new FeatureReadinessBootService(
      failingQuery(new Error('unreadable')),
      new VerifyFeatureReadinessUseCase(features, new InMemoryFeatureReadinessAdapter()),
    );
    loggerErrorSpy(boot);
    const barrier: FeatureReadinessBarrierPort = {
      awaitInitialVerification: () => boot.awaitInitialVerification(),
    };
    const availability = new FeatureAvailabilityService(
      features, new InMemoryFeatureInstallJobRepository(features), barrier,
    );

    await boot.onApplicationBootstrap();

    await expect(availability.inspect('digital')).resolves.toMatchObject({ installed: true });
    await expect(availability.requireReady('digital')).resolves.toBeUndefined();
  });

  it('falls back to a fixed code when the listing failure code could carry a path', async () => {
    const boot = new FeatureReadinessBootService(
      failingQuery(Object.assign(
        new Error('unable to open database file'),
        { code: 'SQLITE_CANTOPEN: /opt/home-worker/data/worker.db' },
      )),
      new VerifyFeatureReadinessUseCase(
        new InMemoryFeatureRepository([DIGITAL]), new InMemoryFeatureReadinessAdapter(),
      ),
    );
    const error = loggerErrorSpy(boot);

    await boot.onApplicationBootstrap();

    expect(error).toHaveBeenCalledWith(
      'Feature readiness verification skipped: FEATURE_OPERATION_FAILED',
    );
    expect(error.mock.calls.flat().join(' ')).not.toContain('/opt/home-worker');
  });
});

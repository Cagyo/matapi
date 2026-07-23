import { Inject, Injectable } from '@nestjs/common';
import type { Feature } from '../domain/feature.entity';
import { FeatureAlreadyDisabledError } from '../domain/errors/feature-already-disabled.error';
import { FeatureInconsistentError } from '../domain/errors/feature-inconsistent.error';
import { FeatureInstallBusyError } from '../domain/errors/feature-install-busy.error';
import { FeatureNotInstalledError } from '../domain/errors/feature-not-installed.error';
import { FeatureRestartDispatchError } from '../domain/errors/feature-restart-dispatch.error';
import { FeatureStateChangedError } from '../domain/errors/feature-state-changed.error';
import { UnknownFeatureError } from '../domain/errors/unknown-feature.error';
import { isManageableFeature, type ManageableFeatureName } from '../domain/manageable-feature';
import { FEATURE_INSTALL_JOB_REPOSITORY, type FeatureInstallJobRepositoryPort } from '../domain/ports/feature-install-job.repository.port';
import { FEATURE_REPOSITORY, type FeatureRepositoryPort } from '../domain/ports/feature-repository.port';
import { FEATURE_RESTART, type FeatureRestartPort } from '../domain/ports/feature-restart.port';
import { FEATURE_RUNTIME_LIFECYCLE, type FeatureRuntimeLifecycleRegistryPort } from '../domain/ports/feature-runtime-lifecycle.port';
import type { ToggleFeatureInput, ToggleFeatureResult } from './enable-feature.use-case';

@Injectable()
export class DisableFeatureUseCase {
  constructor(
    @Inject(FEATURE_REPOSITORY) private readonly features: FeatureRepositoryPort,
    @Inject(FEATURE_INSTALL_JOB_REPOSITORY)
    private readonly jobs: Pick<FeatureInstallJobRepositoryPort, 'findActive'>,
    @Inject(FEATURE_RUNTIME_LIFECYCLE)
    private readonly lifecycle: Pick<FeatureRuntimeLifecycleRegistryPort, 'beforeDisable' | 'afterEnable'>,
    @Inject(FEATURE_RESTART) private readonly restart: FeatureRestartPort,
  ) {}

  async execute(input: ToggleFeatureInput): Promise<ToggleFeatureResult>;
  async execute(name: string): Promise<ToggleFeatureResult>;
  async execute(input: ToggleFeatureInput | string): Promise<ToggleFeatureResult> {
    if (typeof input === 'string') return this.execute(await this.legacyInput(input));
    const name = this.validate(input);
    const active = await this.jobs.findActive();
    if (active?.feature === name) throw new FeatureInstallBusyError(name);
    await this.requireExpectedState(name, input.expected);

    try {
      await this.lifecycle.beforeDisable(name);
    } catch (error) {
      await this.restoreRuntime(name);
      throw error;
    }

    const feature = await this.features.compareAndSetEnabled({
      name,
      expected: input.expected,
      enabled: false,
    });
    if (!feature) {
      await this.restoreRuntimeIfStillEnabled(name);
      throw new FeatureStateChangedError(name);
    }

    await this.dispatchRestart(name);
    return { feature, restartScope: 'worker' };
  }

  private validate(input: ToggleFeatureInput): ManageableFeatureName {
    if (!isManageableFeature(input.name)) throw new UnknownFeatureError(String(input.name));
    return input.name;
  }

  /** Compatibility path for the legacy command until its receipt workflow replaces it. */
  private async legacyInput(name: string): Promise<ToggleFeatureInput> {
    if (!isManageableFeature(name)) throw new UnknownFeatureError(name);
    const feature = await this.features.findByName(name);
    if (!feature?.installed) throw new FeatureNotInstalledError(name);
    return {
      name,
      expected: {
        installed: feature.installed,
        enabled: feature.enabled,
        attentionReason: feature.attentionReason,
      },
    };
  }

  private async requireExpectedState(
    name: ManageableFeatureName,
    expected: ToggleFeatureInput['expected'],
  ): Promise<void> {
    const feature = await this.features.findByName(name);
    if (feature?.enabled && !feature.installed) throw new FeatureInconsistentError(name);
    if (!feature?.installed) throw new FeatureNotInstalledError(name);
    if (feature.attentionReason !== null || expected.attentionReason !== null) {
      throw new FeatureInconsistentError(name);
    }
    if (!feature.enabled) throw new FeatureAlreadyDisabledError(name);
    if (!sameState(feature, expected)) throw new FeatureStateChangedError(name);
  }

  private async restoreRuntimeIfStillEnabled(name: ManageableFeatureName): Promise<void> {
    try {
      const feature = await this.features.findByName(name);
      if (feature?.enabled) await this.restoreRuntime(name);
    } catch {
      await this.markPartialState(name);
    }
  }

  private async restoreRuntime(name: ManageableFeatureName): Promise<void> {
    try {
      await this.lifecycle.afterEnable(name);
    } catch {
      await this.markPartialState(name);
    }
  }

  private async dispatchRestart(name: ManageableFeatureName): Promise<void> {
    try {
      await this.restart.dispatch('worker');
    } catch {
      await this.features.setAttention(name, 'restart-required').catch(() => undefined);
      throw new FeatureRestartDispatchError(name, 'worker');
    }
  }

  private async markPartialState(name: ManageableFeatureName): Promise<void> {
    await this.features.setAttention(name, 'partial-state-uncertain').catch(() => undefined);
  }
}

function sameState(feature: Feature, expected: ToggleFeatureInput['expected']): boolean {
  return feature.installed === expected.installed
    && feature.enabled === expected.enabled
    && feature.attentionReason === expected.attentionReason;
}

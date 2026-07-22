import { describe, expect, it } from 'vitest';
import { FEATURE_CATALOG } from '../../../src/features/domain/feature-catalog';
import {
  MANAGEABLE_FEATURE_NAMES,
  isManageableFeature,
  parseFeatureInstallResult,
} from '../../../src/features/domain/manageable-feature';
import { deriveFeatureStatus } from '../../../src/features/domain/feature-status';
import { FeatureInconsistentError } from '../../../src/features/domain/errors/feature-inconsistent.error';
import { FeatureInstallBusyError } from '../../../src/features/domain/errors/feature-install-busy.error';
import { FeatureRestartDispatchError } from '../../../src/features/domain/errors/feature-restart-dispatch.error';
import { FeatureStateChangedError } from '../../../src/features/domain/errors/feature-state-changed.error';
import { FeatureUnavailableError } from '../../../src/features/domain/errors/feature-unavailable.error';
import { FeatureVerificationError } from '../../../src/features/domain/errors/feature-verification.error';

describe('manageable feature domain', () => {
  it('exposes exactly the five supported names', () => {
    expect(MANAGEABLE_FEATURE_NAMES).toEqual([
      'digital',
      'uart',
      'zigbee',
      'motion',
      'rtsp',
    ]);
    expect(isManageableFeature('neobox')).toBe(false);
    expect(isManageableFeature('4g')).toBe(false);
    expect(FEATURE_CATALOG.map((entry) => entry.name)).toEqual(
      MANAGEABLE_FEATURE_NAMES,
    );
  });

  it.each([
    [false, false, 'not-installed', 'install'],
    [true, false, 'installed-off', 'enable'],
    [true, true, 'enabled', 'disable'],
  ] as const)(
    'derives %s/%s as %s with %s',
    (installed, enabled, display, action) => {
      expect(
        deriveFeatureStatus(
          {
            name: 'digital',
            installed,
            enabled,
            config: null,
            attentionReason: null,
          },
          null,
        ),
      ).toMatchObject({ display, action, ready: installed });
    },
  );

  it('fails closed for enabled without installed', () => {
    expect(
      deriveFeatureStatus(
        {
          name: 'uart',
          installed: false,
          enabled: true,
          config: null,
          attentionReason: null,
        },
        null,
      ),
    ).toMatchObject({
      display: 'needs-attention',
      action: null,
      ready: false,
      attentionReason: 'inconsistent-state',
    });
  });

  it('shows an active same-feature job as installing with no mutation', () => {
    expect(
      deriveFeatureStatus(
        {
          name: 'motion',
          installed: false,
          enabled: false,
          config: null,
          attentionReason: null,
        },
        { id: 'abcdefghijklmnop', feature: 'motion', status: 'running' },
      ),
    ).toMatchObject({ display: 'installing', action: null, busy: true });
  });

  it.each(['inconsistent-state', 'restart-required', 'helper-update-required'] as const)(
    'derives local guidance reason %s with no action',
    (attentionReason) => {
      expect(
        deriveFeatureStatus(
          {
            name: 'rtsp',
            installed: true,
            enabled: false,
            config: null,
            attentionReason,
          },
          null,
        ),
      ).toMatchObject({
        display: 'needs-attention',
        action: null,
        ready: false,
      });
    },
  );

  it.each(['readiness-failed', 'install-failed', 'partial-state-uncertain'] as const)(
    'derives verifiable damage reason %s with verify action',
    (attentionReason) => {
      expect(
        deriveFeatureStatus(
          {
            name: 'rtsp',
            installed: true,
            enabled: false,
            config: null,
            attentionReason,
          },
          null,
        ),
      ).toMatchObject({
        display: 'needs-attention',
        action: 'verify',
        ready: false,
      });
    },
  );

  it('rejects unknown result keys and unsafe failure text', () => {
    expect(() =>
      parseFeatureInstallResult(
        JSON.stringify({
          version: 1,
          jobId: 'abcdefghijklmnop',
          feature: 'rtsp',
          outcome: 'failed',
          failureCode: 'raw stderr',
          privilegedReady: false,
          restartScope: null,
          extra: 'x',
        }),
      ),
    ).toThrow(RangeError);
  });

  it('rejects a success result without privileged readiness and restart scope', () => {
    for (const result of [
      { privilegedReady: false, restartScope: 'worker' },
      { privilegedReady: true, restartScope: null },
    ]) {
      expect(() =>
        parseFeatureInstallResult(
          JSON.stringify({
            version: 1,
            jobId: 'abcdefghijklmnop',
            feature: 'rtsp',
            outcome: 'succeeded',
            failureCode: null,
            ...result,
          }),
        ),
      ).toThrow(RangeError);
    }
  });

  it('rejects a result with a non-string job id', () => {
    expect(() =>
      parseFeatureInstallResult(
        JSON.stringify({
          version: 1,
          jobId: 1234567890123456,
          feature: 'rtsp',
          outcome: 'failed',
          failureCode: 'interrupted',
          privilegedReady: false,
          restartScope: null,
        }),
      ),
    ).toThrow(RangeError);
  });

  it('exposes stable, typed domain error codes', () => {
    expect(new FeatureInstallBusyError('uart')).toMatchObject({
      code: 'FEATURE_INSTALL_BUSY',
      activeFeature: 'uart',
    });
    expect(new FeatureStateChangedError('zigbee')).toMatchObject({
      code: 'FEATURE_STATE_CHANGED',
      feature: 'zigbee',
    });
    expect(
      new FeatureVerificationError('motion', 'readiness-failed'),
    ).toMatchObject({ code: 'FEATURE_VERIFICATION_FAILED' });
    expect(new FeatureRestartDispatchError('rtsp', 'worker')).toMatchObject({
      code: 'FEATURE_RESTART_DISPATCH_FAILED',
    });
    expect(new FeatureUnavailableError('digital', 'installing')).toMatchObject({
      code: 'FEATURE_UNAVAILABLE',
    });
    expect(new FeatureInconsistentError('digital')).toMatchObject({
      code: 'FEATURE_INCONSISTENT',
    });
  });
});

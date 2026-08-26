import { describe, expect, it } from 'vitest';
import {
  CAMERA_SOURCE_FAILURE_KINDS,
  CAMERA_SOURCE_RECOVERY_ACTIONS,
  presentCameraSourceError,
  type CameraSourceFailureKind,
} from '../../../src/telegram/interfaces/camera-source-error.presenter';
import { CameraIdCollisionError } from '../../../src/camera/domain/errors/camera-id-collision.error';
import { CameraNameTakenError } from '../../../src/camera/domain/errors/camera-name-taken.error';
import { CameraNotFoundError } from '../../../src/camera/domain/errors/camera-not-found.error';
import { CameraSourceAdminRequiredError } from '../../../src/camera/domain/errors/camera-source-admin-required.error';
import { CameraSourceUnavailableError } from '../../../src/camera/domain/errors/camera-source-unavailable.error';
import { InvalidLiveSourceError } from '../../../src/camera/domain/errors/invalid-live-source.error';
import { LiveSourceAddressOutsidePolicyError } from '../../../src/camera/domain/errors/live-source-address-outside-policy.error';
import { LiveSourceAuthenticationRejectedError } from '../../../src/camera/domain/errors/live-source-authentication-rejected.error';
import { LiveSourceCredentialConfigurationError } from '../../../src/camera/domain/errors/live-source-credential-configuration.error';
import { LiveSourceCredentialUnavailableError } from '../../../src/camera/domain/errors/live-source-credential-unavailable.error';
import { LiveSourceHostNotFoundError } from '../../../src/camera/domain/errors/live-source-host-not-found.error';
import { LiveSourceHostUnreachableError } from '../../../src/camera/domain/errors/live-source-host-unreachable.error';
import { LiveSourceNetworkPolicyInvalidError } from '../../../src/camera/domain/errors/live-source-network-policy-invalid.error';
import { LiveSourceProbeBaseError } from '../../../src/camera/domain/errors/live-source-probe-base.error';
import { LiveSourceProbeFailedError } from '../../../src/camera/domain/errors/live-source-probe-failed.error';
import { LiveSourceProbeTimeoutError } from '../../../src/camera/domain/errors/live-source-probe-timeout.error';
import { LiveSourceStateChangedError } from '../../../src/camera/domain/errors/live-source-state-changed.error';
import { LiveSourceTlsVerificationError } from '../../../src/camera/domain/errors/live-source-tls-verification.error';
import { LiveSourceUnsupportedStreamError } from '../../../src/camera/domain/errors/live-source-unsupported-stream.error';
import { FeatureAlreadyEnabledError } from '../../../src/features/domain/errors/feature-already-enabled.error';
import { FeatureInconsistentError } from '../../../src/features/domain/errors/feature-inconsistent.error';
import { FeatureInstallBusyError } from '../../../src/features/domain/errors/feature-install-busy.error';
import { FeatureInstallStartError } from '../../../src/features/domain/errors/feature-install-start.error';
import { FeatureNotInstalledError } from '../../../src/features/domain/errors/feature-not-installed.error';
import { FeatureRestartDispatchError } from '../../../src/features/domain/errors/feature-restart-dispatch.error';
import { FeatureStateChangedError } from '../../../src/features/domain/errors/feature-state-changed.error';
import { FeatureUnavailableError } from '../../../src/features/domain/errors/feature-unavailable.error';
import { FeatureVerificationError } from '../../../src/features/domain/errors/feature-verification.error';
import { RtspPolicyDigestMismatchError } from '../../../src/features/domain/errors/rtsp-policy-digest-mismatch.error';
import { RtspPolicyUnavailableError } from '../../../src/features/domain/errors/rtsp-policy-unavailable.error';

/**
 * One typed Camera/Features error per failure kind, plus every other error the
 * mutation, probe, removal and readiness paths can reject with. The table is
 * the contract: a new error class that nobody adds here falls to the generic
 * kind, which is the safe answer but never the useful one.
 */
const CLASSIFIED: readonly (readonly [
  string,
  () => unknown,
  CameraSourceFailureKind,
])[] = [
  ['InvalidLiveSourceError', () => new InvalidLiveSourceError('URL is malformed'), 'invalid-address'],
  ['LiveSourceAddressOutsidePolicyError', () => new LiveSourceAddressOutsidePolicyError(), 'outside-policy'],
  ['CameraNameTakenError', () => new CameraNameTakenError(), 'name-taken'],
  ['LiveSourceHostNotFoundError', () => new LiveSourceHostNotFoundError(), 'host-not-found'],
  ['LiveSourceHostUnreachableError', () => new LiveSourceHostUnreachableError(), 'host-unreachable'],
  ['LiveSourceAuthenticationRejectedError', () => new LiveSourceAuthenticationRejectedError(), 'authentication-failed'],
  ['LiveSourceTlsVerificationError', () => new LiveSourceTlsVerificationError(), 'tls-verification-failed'],
  ['LiveSourceUnsupportedStreamError', () => new LiveSourceUnsupportedStreamError(), 'unsupported-stream'],
  ['LiveSourceProbeTimeoutError', () => new LiveSourceProbeTimeoutError(), 'timed-out'],
  ['LiveSourceProbeFailedError', () => new LiveSourceProbeFailedError(), 'probe-failed'],
  ['CameraSourceUnavailableError(rtsp-closed)', () => new CameraSourceUnavailableError('rtsp-closed'), 'feature-unavailable'],
  ['CameraSourceUnavailableError(session-stop-failed)', () => new CameraSourceUnavailableError('session-stop-failed'), 'feature-unavailable'],
  ['CameraSourceAdminRequiredError', () => new CameraSourceAdminRequiredError(), 'feature-unavailable'],
  ['FeatureUnavailableError', () => new FeatureUnavailableError('rtsp', 'installed-off'), 'feature-unavailable'],
  ['FeatureNotInstalledError', () => new FeatureNotInstalledError('rtsp'), 'feature-unavailable'],
  ['FeatureStateChangedError', () => new FeatureStateChangedError('rtsp'), 'feature-unavailable'],
  ['FeatureVerificationError', () => new FeatureVerificationError('rtsp', 'readiness-failed'), 'feature-unavailable'],
  ['FeatureInstallBusyError', () => new FeatureInstallBusyError('rtsp'), 'feature-unavailable'],
  ['FeatureInstallStartError', () => new FeatureInstallStartError('rtsp'), 'feature-unavailable'],
  ['FeatureAlreadyEnabledError', () => new FeatureAlreadyEnabledError('rtsp'), 'feature-unavailable'],
  ['FeatureInconsistentError', () => new FeatureInconsistentError('rtsp'), 'feature-unavailable'],
  ['FeatureRestartDispatchError', () => new FeatureRestartDispatchError('rtsp', 'worker'), 'feature-unavailable'],
  ['RtspPolicyUnavailableError', () => new RtspPolicyUnavailableError('stale'), 'policy-stale'],
  ['RtspPolicyDigestMismatchError', () => new RtspPolicyDigestMismatchError('digest-abc'), 'policy-stale'],
  ['LiveSourceNetworkPolicyInvalidError', () => new LiveSourceNetworkPolicyInvalidError(), 'policy-stale'],
  ['LiveSourceStateChangedError', () => new LiveSourceStateChangedError(), 'source-stale'],
  ['CameraNotFoundError', () => new CameraNotFoundError('front_door'), 'source-stale'],
];

/** Errors deliberately left to the generic kind, listed so the choice is visible. */
const UNCLASSIFIED: readonly (readonly [string, () => unknown])[] = [
  ['CameraIdCollisionError', () => new CameraIdCollisionError()],
  ['LiveSourceCredentialUnavailableError', () => new LiveSourceCredentialUnavailableError()],
  ['LiveSourceCredentialConfigurationError', () => new LiveSourceCredentialConfigurationError()],
  ['a plain Error', () => new Error('rtsp://admin:hunter2@10.0.0.9:554/stream1 refused')],
  ['a string', () => 'rtsp://admin:hunter2@10.0.0.9/stream1'],
  ['null', () => null],
  ['undefined', () => undefined],
  ['a bare object', () => ({ code: 'LIVE_SOURCE_HOST_NOT_FOUND' })],
];

describe('presentCameraSourceError', () => {
  it.each(CLASSIFIED)('maps %s to its own failure kind', (_name, make, kind) => {
    expect(presentCameraSourceError(make()).kind).toBe(kind);
  });

  it.each(UNCLASSIFIED)('falls back to the generic kind for %s', (_name, make) => {
    expect(presentCameraSourceError(make()).kind).toBe('probe-failed');
  });

  it('renders the documented authentication answer exactly', () => {
    expect(presentCameraSourceError(new LiveSourceAuthenticationRejectedError()))
      .toEqual({ kind: 'authentication-failed', actions: ['change-address', 'back'] });
  });

  it('produces every declared failure kind from a real error', () => {
    const produced = new Set(CLASSIFIED.map(([, make]) => presentCameraSourceError(make()).kind));
    produced.add(presentCameraSourceError(new Error('unknown')).kind);
    expect([...produced].sort()).toEqual([...CAMERA_SOURCE_FAILURE_KINDS].sort());
  });

  /*
   * Ordering guard. Seven probe kinds extend `LiveSourceProbeBaseError`; a
   * chain that tested the base first would collapse all of them into the
   * generic kind and no per-error expectation above would survive it.
   */
  it('classifies each probe subclass before the shared base', () => {
    const subclasses: readonly LiveSourceProbeBaseError[] = [
      new LiveSourceAddressOutsidePolicyError(),
      new LiveSourceHostNotFoundError(),
      new LiveSourceHostUnreachableError(),
      new LiveSourceAuthenticationRejectedError(),
      new LiveSourceTlsVerificationError(),
      new LiveSourceUnsupportedStreamError(),
      new LiveSourceProbeTimeoutError(),
    ];
    const kinds = subclasses.map((error) => presentCameraSourceError(error).kind);

    expect(subclasses).toHaveLength(7);
    expect(new Set(kinds).size).toBe(subclasses.length);
    expect(kinds).not.toContain('probe-failed');
  });

  it('recognizes an unlisted probe subclass through the shared base', () => {
    class LiveSourceFutureProbeError extends LiveSourceProbeBaseError {
      readonly code = 'LIVE_SOURCE_FUTURE' as const;
      constructor() {
        super('a probe kind added after this presenter was written');
        this.name = 'LiveSourceFutureProbeError';
      }
    }
    expect(presentCameraSourceError(new LiveSourceFutureProbeError()).kind).toBe('probe-failed');
  });

  /*
   * The whole recovery table, pinned. The per-kind lists are a product
   * decision Tasks 4-6 render as buttons, so "an action list somewhere is
   * plausible" is not enough: every list is written out here, and adding or
   * dropping one control fails this test rather than silently changing what an
   * administrator is offered after a failure.
   */
  it('offers exactly the recovery controls each failure kind earns', () => {
    const table: Record<CameraSourceFailureKind, readonly string[]> = {
      'invalid-address': ['change-address', 'back'],
      'outside-policy': ['change-address', 'back'],
      'name-taken': ['back'],
      'host-not-found': ['retry', 'change-address', 'back'],
      'host-unreachable': ['retry', 'change-address', 'back'],
      'authentication-failed': ['change-address', 'back'],
      'tls-verification-failed': ['change-address', 'back'],
      'unsupported-stream': ['change-address', 'back'],
      'timed-out': ['retry', 'change-address', 'back'],
      'feature-unavailable': ['retry', 'back'],
      'policy-stale': ['reinstall-rtsp', 'back'],
      'source-stale': ['back'],
      'probe-failed': ['retry', 'change-address', 'back'],
    };

    expect(Object.keys(table).sort()).toEqual([...CAMERA_SOURCE_FAILURE_KINDS].sort());
    for (const [name, make, kind] of CLASSIFIED) {
      expect(presentCameraSourceError(make()).actions, `${name} (${kind})`).toEqual(table[kind]);
    }
    expect(presentCameraSourceError(new Error('unknown')).actions).toEqual(table['probe-failed']);
  });

  it('offers only declared recovery actions, always ending in an escape', () => {
    for (const [name, make] of [...CLASSIFIED, ...UNCLASSIFIED.map(([n, m]) => [n, m] as const)]) {
      const { actions } = presentCameraSourceError(make());
      expect(actions.length, name).toBeGreaterThan(0);
      expect(new Set(actions).size, name).toBe(actions.length);
      for (const action of actions) expect(CAMERA_SOURCE_RECOVERY_ACTIONS, name).toContain(action);
      expect(actions.at(-1), name).toBe('back');
    }
  });

  it('reserves the RTSP reinstall offer for a stale policy', () => {
    for (const [name, make, kind] of CLASSIFIED) {
      const offersReinstall = presentCameraSourceError(make()).actions.includes('reinstall-rtsp');
      expect(offersReinstall, name).toBe(kind === 'policy-stale');
    }
  });

  it('never offers a retry that would reuse a revision the source has moved past', () => {
    expect(presentCameraSourceError(new LiveSourceStateChangedError()).actions).toEqual(['back']);
  });

  /*
   * The security boundary. Every input below carries something that must not
   * reach a Telegram chat — a credentialed URL, a host, a camera name, a policy
   * digest, a feature identity — and the DTO is asserted whole, so an added
   * `message`, `cause` or diagnostic field fails here rather than shipping.
   */
  it('returns inert data carrying nothing from the error it classified', () => {
    const secrets = ['hunter2', 'rtsp://', '10.0.0.9', 'admin', 'front_door', 'digest-abc', 'stream1'];
    const inputs: readonly unknown[] = [
      ...CLASSIFIED.map(([, make]) => make()),
      ...UNCLASSIFIED.map(([, make]) => make()),
      new InvalidLiveSourceError('rtsp://admin:hunter2@10.0.0.9:554/stream1'),
      Object.assign(new Error('boom'), { cause: new Error('rtsp://admin:hunter2@10.0.0.9/stream1') }),
    ];

    for (const input of inputs) {
      const presented = presentCameraSourceError(input);
      expect(Object.keys(presented).sort()).toEqual(['actions', 'kind']);
      const serialized = JSON.stringify(presented);
      for (const secret of secrets) expect(serialized).not.toContain(secret);
    }
  });

  it('hands back frozen action lists that a caller cannot rewrite', () => {
    const first = presentCameraSourceError(new LiveSourceProbeTimeoutError()).actions;
    expect(Object.isFrozen(first)).toBe(true);
    expect(presentCameraSourceError(new LiveSourceProbeTimeoutError()).actions)
      .toEqual(['retry', 'change-address', 'back']);
  });
});

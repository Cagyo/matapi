import { CameraNameTakenError } from '../../camera/domain/errors/camera-name-taken.error';
import { CameraNotFoundError } from '../../camera/domain/errors/camera-not-found.error';
import { CameraSourceAdminRequiredError } from '../../camera/domain/errors/camera-source-admin-required.error';
import { CameraSourceUnavailableError } from '../../camera/domain/errors/camera-source-unavailable.error';
import { InvalidLiveSourceError } from '../../camera/domain/errors/invalid-live-source.error';
import { LiveSourceAddressOutsidePolicyError } from '../../camera/domain/errors/live-source-address-outside-policy.error';
import { LiveSourceAuthenticationRejectedError } from '../../camera/domain/errors/live-source-authentication-rejected.error';
import { LiveSourceHostNotFoundError } from '../../camera/domain/errors/live-source-host-not-found.error';
import { LiveSourceHostUnreachableError } from '../../camera/domain/errors/live-source-host-unreachable.error';
import { LiveSourceNetworkPolicyInvalidError } from '../../camera/domain/errors/live-source-network-policy-invalid.error';
import { LiveSourceProbeBaseError } from '../../camera/domain/errors/live-source-probe-base.error';
import { LiveSourceProbeTimeoutError } from '../../camera/domain/errors/live-source-probe-timeout.error';
import { LiveSourceStateChangedError } from '../../camera/domain/errors/live-source-state-changed.error';
import { LiveSourceTlsVerificationError } from '../../camera/domain/errors/live-source-tls-verification.error';
import { LiveSourceUnsupportedStreamError } from '../../camera/domain/errors/live-source-unsupported-stream.error';
import { FeatureAlreadyEnabledError } from '../../features/domain/errors/feature-already-enabled.error';
import { FeatureInconsistentError } from '../../features/domain/errors/feature-inconsistent.error';
import { FeatureInstallBusyError } from '../../features/domain/errors/feature-install-busy.error';
import { FeatureInstallStartError } from '../../features/domain/errors/feature-install-start.error';
import { FeatureNotInstalledError } from '../../features/domain/errors/feature-not-installed.error';
import { FeatureRestartDispatchError } from '../../features/domain/errors/feature-restart-dispatch.error';
import { FeatureStateChangedError } from '../../features/domain/errors/feature-state-changed.error';
import { FeatureUnavailableError } from '../../features/domain/errors/feature-unavailable.error';
import { FeatureVerificationError } from '../../features/domain/errors/feature-verification.error';
import { RtspPolicyDigestMismatchError } from '../../features/domain/errors/rtsp-policy-digest-mismatch.error';
import { RtspPolicyUnavailableError } from '../../features/domain/errors/rtsp-policy-unavailable.error';

/**
 * Everything the RTSP source workflow is allowed to tell an administrator went
 * wrong. Closed on purpose: `camera.sources.errors` is keyed by this union in
 * every locale, so adding a kind without copy is a build failure.
 */
export const CAMERA_SOURCE_FAILURE_KINDS = [
  'invalid-address',
  'outside-policy',
  'name-taken',
  'host-not-found',
  'host-unreachable',
  'authentication-failed',
  'tls-verification-failed',
  'unsupported-stream',
  'timed-out',
  'feature-unavailable',
  'policy-stale',
  'source-stale',
  'probe-failed',
] as const;

export type CameraSourceFailureKind = (typeof CAMERA_SOURCE_FAILURE_KINDS)[number];

/** The only controls a failure screen may offer. `back` reloads current state. */
export const CAMERA_SOURCE_RECOVERY_ACTIONS = [
  'retry',
  'change-address',
  'back',
  'reinstall-rtsp',
] as const;

export type CameraSourceRecoveryAction = (typeof CAMERA_SOURCE_RECOVERY_ACTIONS)[number];

export interface PresentedCameraSourceFailure {
  kind: CameraSourceFailureKind;
  actions: readonly CameraSourceRecoveryAction[];
}

/**
 * Recovery is a property of the kind, never of the error instance: two callers
 * that classify the same failure must offer the same way out.
 *
 * - `retry` re-runs the identical request, so it appears only where the same
 *   request can succeed on a second attempt — a resolver hiccup, a camera still
 *   booting, an RTSP feature mid-restart.
 * - `change-address` re-opens the credential prompt, so it appears wherever the
 *   address, path or credentials are a plausible cause.
 * - `reinstall-rtsp` is reserved for `policy-stale`, the one condition nothing
 *   inside this screen can fix. Task 6 routes it to the existing receipt-bound
 *   reinstall confirmation rather than starting a second mutation path.
 * - `back` is last everywhere: an administrator always has one escape that
 *   re-reads current state instead of acting on what this screen remembers.
 */
const RECOVERY: Record<CameraSourceFailureKind, readonly CameraSourceRecoveryAction[]> = {
  'invalid-address': ['change-address', 'back'],
  'outside-policy': ['change-address', 'back'],
  // No `change-name` control exists, and `retry` would resubmit the rejected
  // name unchanged, so the only honest way forward is back to the overview.
  'name-taken': ['back'],
  'host-not-found': ['retry', 'change-address', 'back'],
  'host-unreachable': ['retry', 'change-address', 'back'],
  'authentication-failed': ['change-address', 'back'],
  'tls-verification-failed': ['change-address', 'back'],
  'unsupported-stream': ['change-address', 'back'],
  'timed-out': ['retry', 'change-address', 'back'],
  'feature-unavailable': ['retry', 'back'],
  'policy-stale': ['reinstall-rtsp', 'back'],
  // Retrying would re-send the revision the source has already moved past, which
  // Task 6 forbids: the caller re-reads the detail and decides again.
  'source-stale': ['back'],
  'probe-failed': ['retry', 'change-address', 'back'],
};

for (const actions of Object.values(RECOVERY)) Object.freeze(actions);
Object.freeze(RECOVERY);

/**
 * Classifies a Camera or Features rejection into copy the RTSP source screens
 * may render, and nothing else.
 *
 * Every one of these errors can reach a Telegram chat, and the URL that
 * produced most of them carries the camera password. So this is the boundary
 * that makes an error inert: the result is a kind and a list of controls, with
 * no message, no `cause`, no URL, host, username, camera identity, policy
 * digest, or child diagnostic. Callers render
 * `catalog.camera.sources.errors[kind]` — never `error.message`.
 *
 * Recognition is `instanceof` and closed discriminators only; nothing is parsed
 * out of a message. An error this table does not know becomes the generic
 * `probe-failed`, which is the least specific answer rather than a leaky one.
 */
export function presentCameraSourceError(error: unknown): PresentedCameraSourceFailure {
  const kind = classify(error);
  return { kind, actions: RECOVERY[kind] };
}

function classify(error: unknown): CameraSourceFailureKind {
  // Probe subclasses first, every one of them: `LiveSourceProbeBaseError` is
  // their shared root, so a base arm placed above these would swallow all seven
  // and report the generic kind for failures that have real advice to give.
  if (error instanceof LiveSourceAddressOutsidePolicyError) return 'outside-policy';
  if (error instanceof LiveSourceHostNotFoundError) return 'host-not-found';
  if (error instanceof LiveSourceHostUnreachableError) return 'host-unreachable';
  if (error instanceof LiveSourceAuthenticationRejectedError) return 'authentication-failed';
  if (error instanceof LiveSourceTlsVerificationError) return 'tls-verification-failed';
  if (error instanceof LiveSourceUnsupportedStreamError) return 'unsupported-stream';
  if (error instanceof LiveSourceProbeTimeoutError) return 'timed-out';
  // The base arm is what keeps a probe kind added later from arriving here as an
  // unrecognized throw; it is deliberately below every subclass above.
  if (error instanceof LiveSourceProbeBaseError) return 'probe-failed';

  if (error instanceof InvalidLiveSourceError) return 'invalid-address';
  if (error instanceof CameraNameTakenError) return 'name-taken';

  // The source moved under the caller. `CameraNotFoundError` is the same story
  // told by the read side: reload the overview, do not reuse the old revision.
  if (error instanceof LiveSourceStateChangedError) return 'source-stale';
  if (error instanceof CameraNotFoundError) return 'source-stale';

  // The installed network policy is not the one in force. Nothing on the source
  // screens can reconcile that; only a reinstall can.
  if (error instanceof RtspPolicyUnavailableError) return 'policy-stale';
  if (error instanceof RtspPolicyDigestMismatchError) return 'policy-stale';
  if (error instanceof LiveSourceNetworkPolicyInvalidError) return 'policy-stale';

  // RTSP itself is not usable for this mutation right now. Handlers that have
  // richer copy for a particular case — the feature-state notices, and the
  // administrator-required reply — render it before consulting this presenter;
  // reaching here is the safe generic answer for the same conditions.
  if (error instanceof CameraSourceUnavailableError) return 'feature-unavailable';
  if (error instanceof CameraSourceAdminRequiredError) return 'feature-unavailable';
  if (error instanceof FeatureUnavailableError) return 'feature-unavailable';
  if (error instanceof FeatureNotInstalledError) return 'feature-unavailable';
  if (error instanceof FeatureStateChangedError) return 'feature-unavailable';
  if (error instanceof FeatureVerificationError) return 'feature-unavailable';
  if (error instanceof FeatureInstallBusyError) return 'feature-unavailable';
  if (error instanceof FeatureInstallStartError) return 'feature-unavailable';
  if (error instanceof FeatureAlreadyEnabledError) return 'feature-unavailable';
  if (error instanceof FeatureInconsistentError) return 'feature-unavailable';
  if (error instanceof FeatureRestartDispatchError) return 'feature-unavailable';

  return 'probe-failed';
}

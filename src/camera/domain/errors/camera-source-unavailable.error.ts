/**
 * A camera-source mutation could not be completed because RTSP went away
 * underneath it. Deliberately not `LiveStreamUnavailableError`: that error means
 * "the stream you asked to watch cannot start" and renders as stream copy, which
 * is the wrong thing to tell an administrator who was adding or editing a
 * camera. The two conditions that reach an admin mid-mutation are separated by
 * `reason` so the interface layer can say which one happened.
 *
 * Parameterless beyond the reason: a stop failure originates in session
 * machinery that may quote runtime detail, and none of it — nor any `cause` —
 * may travel with a failure that reaches Telegram.
 */
export type CameraSourceUnavailableReason =
  /** RTSP closed (feature disabled, policy reinstall, runtime teardown). */
  | 'rtsp-closed'
  /** The camera could not be taken off air before the change was applied. */
  | 'session-stop-failed';

export class CameraSourceUnavailableError extends Error {
  readonly code = 'CAMERA_SOURCE_UNAVAILABLE' as const;

  constructor(readonly reason: CameraSourceUnavailableReason) {
    super(
      reason === 'rtsp-closed'
        ? 'RTSP camera support became unavailable before the change was saved'
        : 'The camera could not be taken off air before the change was saved',
    );
    this.name = 'CameraSourceUnavailableError';
  }
}

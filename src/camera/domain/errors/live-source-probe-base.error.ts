/**
 * Shared root of every failure `LiveSourceProbePort.run` rejects with.
 *
 * It exists so that recognizing a probe failure is one `instanceof` check
 * rather than a hand-maintained list: a new kind is recognized everywhere the
 * moment it extends this base. `LiveSourceProbeError` in
 * `live-source-probe.port.ts` remains the exhaustive union used for rendering,
 * and a compile-time assertion there keeps the two in step.
 *
 * Subclasses are parameterless on purpose. The probed URL carries the camera
 * password, so no probe error may carry a URL, host, credential, `cause`, or
 * raw process output.
 */
export abstract class LiveSourceProbeBaseError extends Error {
  abstract readonly code: string;
}

/**
 * The live-source host name did not resolve to any address.
 *
 * Like every probe error, this carries no hostname, URL, or resolver text: the
 * probed URL holds the camera password, and the message reaches an operator
 * chat. The kind alone is what makes the failure actionable.
 */
export class LiveSourceHostNotFoundError extends Error {
  readonly code = 'LIVE_SOURCE_HOST_NOT_FOUND' as const;

  constructor() {
    super('Live source host name could not be resolved');
    this.name = 'LiveSourceHostNotFoundError';
  }
}

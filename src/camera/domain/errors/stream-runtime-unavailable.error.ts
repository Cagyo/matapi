export class StreamRuntimeUnavailableError extends Error {
  constructor() {
    super('stream runtime unavailable');
    this.name = 'StreamRuntimeUnavailableError';
  }
}

export class StreamEgressUnavailableError extends Error {
  constructor() {
    super('stream egress unavailable');
    this.name = 'StreamEgressUnavailableError';
  }
}

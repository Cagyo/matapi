import { Injectable } from '@nestjs/common';
import type { LiveStreamCapabilityPort } from '../domain/ports/live-stream-capability.port';

/** Stub-mode capability: config-gated, with no system dependency probe. */
@Injectable()
export class AvailableLiveStreamCapabilityAdapter implements LiveStreamCapabilityPort {
  constructor(private readonly enabled = true) {}

  async isAvailable(): Promise<boolean> {
    return this.enabled;
  }
}

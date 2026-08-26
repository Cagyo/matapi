import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CameraIdGeneratorPort } from '../domain/ports/camera-id-generator.port';

/**
 * Opaque camera identifiers from the platform CSPRNG. Nothing about the display
 * name, the URL, or the actor leaks into the value, so the identifier stays
 * safe to put in callback data and log lines.
 */
@Injectable()
export class CryptoCameraIdGeneratorAdapter implements CameraIdGeneratorPort {
  generate(): string {
    return randomUUID();
  }
}

import { describe, expect, it } from 'vitest';
import type { CameraIdGeneratorPort } from '../../../src/camera/domain/ports/camera-id-generator.port';
import { CryptoCameraIdGeneratorAdapter } from '../../../src/camera/infrastructure/crypto-camera-id-generator.adapter';

describe('CryptoCameraIdGeneratorAdapter', () => {
  it('generates opaque identifiers that carry no caller-supplied meaning', () => {
    // Typed as the port so a deterministic stub can stand in for it in tests.
    const generator: CameraIdGeneratorPort = new CryptoCameraIdGeneratorAdapter();

    const ids = Array.from({ length: 64 }, () => generator.generate());

    expect(new Set(ids).size).toBe(64);
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
  });
});

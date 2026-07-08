import { describe, expect, it } from 'vitest';
import { en } from '../../../src/locales/en';

describe('en.camera.driveLinkFallback', () => {
  it('shows the Drive remote path, never a fabricated drive.google.com URL', () => {
    const text = en.camera.driveLinkFallback(7, 'home-security/motion/2026/07/08/1.mp4');

    expect(text).toContain('home-security/motion/2026/07/08/1.mp4');
    expect(text).not.toContain('drive.google.com');
  });

  it('explains when no Drive copy exists yet', () => {
    const text = en.camera.driveLinkFallback(7, null);

    expect(text.toLowerCase()).toContain('no drive copy');
  });
});

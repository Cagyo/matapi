import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function motionCase(script: string): string {
  const match = /\n  motion\)\n([\s\S]*?)\n    ;;\n  zigbee\)/.exec(script);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('motion install scripts', () => {
  it('makes the Motion video path traversable and writable during feature install', () => {
    const script = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');
    const block = motionCase(script);

    expect(block).toContain('sudo chmod 755 /home/pi');
    expect(block).toContain('sudo chown -R motion:motion /home/pi/motion');
    expect(block).toContain('sudo chmod 755 /home/pi/motion');
    expect(block).toContain('sudo chmod -R 775 /home/pi/motion/videos');
  });

  it('repairs Motion video permissions during the main install flow', () => {
    const script = readFileSync(resolve('scripts/install.sh'), 'utf8');

    expect(script).toContain('ensure_motion_video_storage_permissions');
    expect(script).toContain('sudo chmod 755 /home/pi');
    expect(script).toContain('sudo chown -R motion:motion /home/pi/motion');
    expect(script).toContain('sudo chmod 755 /home/pi/motion');
    expect(script).toContain('sudo chmod -R 775 "$motion_dir"');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function motionCase(script: string): string {
  const match = /\n {2}motion\)\n([\s\S]*?)\n {4};;\n {2}zigbee\)/.exec(script);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('motion install scripts', () => {
  it('makes the Motion video path traversable and writable during feature install', () => {
    const script = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');
    const block = motionCase(script);

    expect(block).toContain('sudo mkdir -p /home/pi/motion/videos /home/pi/motion/thumbnails');
    expect(block).toContain('sudo chmod 755 /home/pi');
    expect(block).toContain('sudo chown -R motion:motion /home/pi/motion');
    expect(block).toContain('sudo chmod 755 /home/pi/motion');
    expect(block).toContain('sudo chmod -R 775 /home/pi/motion/videos');
    expect(block).toContain('sudo chmod -R 775 /home/pi/motion/thumbnails');
    expect(block).toContain('d /home/pi/motion/thumbnails 0775 motion motion - -');
  });

  it('configures Motion video output and thumbnails outside the video directory', () => {
    const script = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');
    const block = motionCase(script);

    expect(block).toContain('set_motion_conf target_dir /home/pi/motion/videos');
    expect(block).toContain('set_motion_conf movie_codec mpeg4');
    expect(block).toContain('set_motion_conf movie_filename "%Y/%m/%d/%H%M%S-%{eventid}"');
    expect(block).toContain('set_motion_conf picture_output first');
    expect(block).toContain('set_motion_conf picture_filename "../thumbnails/%Y/%m/%d/%H%M%S-%{eventid}"');
    expect(block).not.toContain('set_motion_conf picture_output on');
    expect(block).not.toContain('set_motion_conf picture_filename "%Y/%m/%d/%H%M%S"');
  });

  it('configures movie-end hooks so every saved video file reaches the worker', () => {
    const script = readFileSync(resolve('scripts/install-feature.sh'), 'utf8');
    const block = motionCase(script);

    expect(block).toContain('/^[#[:space:]]*on_(event_start|event_end|movie_start|movie_end|picture_save)[[:space:]]/d');
    expect(block).toContain('on_event_start curl -s "http://localhost:4000/motion/event-start?camera=%t"');
    expect(block).toContain('on_movie_end curl -s "http://localhost:4000/motion/movie-end?camera=%t&file=%f"');
    expect(block).toContain('on_picture_save curl -s "http://localhost:4000/motion/snapshot?file=%f"');
    expect(block).not.toContain('on_event_end curl -s "http://localhost:4000/motion/event-end?camera=%t&file=%f"');
  });

});

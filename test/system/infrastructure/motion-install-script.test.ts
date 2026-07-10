import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function motionCase(script: string): string {
  const match = /\n  motion\)\n([\s\S]*?)\n    ;;\n  zigbee\)/.exec(script);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

  it('repairs Motion video permissions during the main install flow', () => {
    const script = readFileSync(resolve('scripts/install.sh'), 'utf8');

    expect(script).toContain('ensure_motion_video_storage_permissions');
    expect(script).toContain('local thumbnails_dir="/home/pi/motion/thumbnails"');
    expect(script).toContain('sudo mkdir -p "$thumbnails_dir"');
    expect(script).toContain('sudo chmod 755 /home/pi');
    expect(script).toContain('sudo chown -R motion:motion /home/pi/motion');
    expect(script).toContain('sudo chmod 755 /home/pi/motion');
    expect(script).toContain('sudo chmod -R 775 "$motion_dir"');
    expect(script).toContain('sudo chmod -R 775 "$thumbnails_dir"');
  });

  it('seeds an enabled Motion camera after database migrations during install', () => {
    const script = readFileSync(resolve('scripts/install.sh'), 'utf8');
    const tempDir = mkdtempSync(join(tmpdir(), 'home worker install '));

    try {
      const fakeBin = join(tempDir, 'bin');
      const installDir = join(tempDir, 'install root');
      const dbPath = join(installDir, 'data', 'worker data.db');
      execFileSync('mkdir', ['-p', fakeBin, join(installDir, 'data')]);
      writeFileSync(
        join(fakeBin, 'sudo'),
        '#!/bin/sh\nif [ "$1" = "-u" ]; then shift 2; fi\nexec "$@"\n',
      );
      chmodSync(join(fakeBin, 'sudo'), 0o755);
      writeFileSync(join(installDir, '.env'), `DATABASE_PATH="${dbPath}"\n`);
      writeFileSync(join(installDir, 'features.json'), '{"enabled":["motion"]}\n');
      execFileSync('sqlite3', [
        dbPath,
        'CREATE TABLE cameras (id text primary key, name text not null unique, type text not null, config text, enabled integer default 1);',
      ]);

      const sourcedInstall = join(tempDir, 'install-functions.sh');
      writeFileSync(sourcedInstall, script.replace(/\nmain "\$@"\s*$/, '\n'));
      const harness = join(tempDir, 'seed-motion-camera.sh');
      writeFileSync(
        harness,
        [
          '#!/bin/bash',
          'set -euo pipefail',
          `export PATH=${shQuote(fakeBin)}:"$PATH"`,
          `export HOME_WORKER_INSTALL_DIR=${shQuote(installDir)}`,
          `. ${shQuote(sourcedInstall)}`,
          'seed_motion_camera_metadata',
          'seed_motion_camera_metadata',
          `sqlite3 ${shQuote(dbPath)} "select id || '|' || name || '|' || type || '|' || enabled from cameras order by id;"`,
          '',
        ].join('\n'),
      );
      chmodSync(harness, 0o755);

      const output = execFileSync('bash', [harness], { encoding: 'utf8' });

      expect(script).toMatch(/run_migrations\s*\n\s*seed_motion_camera_metadata/);
      expect(output.trim().split('\n').at(-1)).toBe('front_door_cam|front_door_cam|motion|1');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

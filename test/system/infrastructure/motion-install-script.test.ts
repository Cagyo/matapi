import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function motionCase(script: string): string {
  const match = /\n {2}motion\)\n([\s\S]*?)\n {4};;\n {2}zigbee\)/.exec(script);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Sources scripts/install.sh as a library and runs one installer function. */
function runInstallFunction(
  tempDir: string,
  functionName: string,
  env: Record<string, string>,
): string {
  const harnessDir = join(tempDir, 'harness');
  const fakeBin = join(harnessDir, 'bin');
  execFileSync('mkdir', ['-p', fakeBin]);
  // Privileged commands run unprivileged here; `chown` to a foreign owner is the
  // one step an unprivileged test user cannot perform, so it becomes a no-op.
  writeFileSync(
    join(fakeBin, 'sudo'),
    '#!/bin/sh\nif [ "$1" = "-u" ]; then shift 2; fi\nif [ "$1" = "chown" ]; then exit 0; fi\nexec "$@"\n',
  );
  chmodSync(join(fakeBin, 'sudo'), 0o755);

  const harness = join(harnessDir, 'run.sh');
  writeFileSync(
    harness,
    [
      '#!/bin/bash',
      'set -euo pipefail',
      `export PATH=${shQuote(fakeBin)}:"$PATH"`,
      'export HOME_WORKER_INSTALL_LIBRARY=1',
      `. ${shQuote(resolve('scripts/install.sh'))}`,
      functionName,
      '',
    ].join('\n'),
  );
  chmodSync(harness, 0o755);

  return execFileSync('bash', [harness], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
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

    expect(script).toMatch(
      /install_selected_features\s*\n\s*ensure_motion_video_storage_permissions/,
    );

    const tempDir = mkdtempSync(join(tmpdir(), 'home-worker-motion-perms-'));
    try {
      const motionHome = join(tempDir, 'home', 'pi');
      const motionDir = join(motionHome, 'motion', 'videos');
      execFileSync('mkdir', ['-p', motionDir]);
      writeFileSync(join(motionDir, 'clip.mp4'), 'video');
      chmodSync(motionHome, 0o700);

      runInstallFunction(tempDir, 'ensure_motion_video_storage_permissions', {
        HOME_WORKER_MOTION_HOME: motionHome,
      });

      expect(mode(motionHome)).toBe(0o755);
      expect(mode(join(motionHome, 'motion'))).toBe(0o755);
      expect(mode(motionDir)).toBe(0o775);
      expect(mode(join(motionDir, 'clip.mp4'))).toBe(0o775);
      expect(mode(join(motionHome, 'motion', 'thumbnails'))).toBe(0o775);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the home directory traversable when the camera feature was never installed', () => {
    // Regression: the worker scans MOTION_LOCAL_DIR on every boot regardless of
    // the camera feature. Skipping `chmod 755 /home/pi` because the media
    // directory is absent left the scan hitting EACCES instead of ENOENT, which
    // crash-looped a camera-less device.
    const tempDir = mkdtempSync(join(tmpdir(), 'home-worker-motion-perms-bare-'));
    try {
      const motionHome = join(tempDir, 'home', 'pi');
      execFileSync('mkdir', ['-p', motionHome]);
      chmodSync(motionHome, 0o700);

      runInstallFunction(tempDir, 'ensure_motion_video_storage_permissions', {
        HOME_WORKER_MOTION_HOME: motionHome,
      });

      expect(mode(motionHome)).toBe(0o755);
      expect(existsSync(join(motionHome, 'motion'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does nothing when the Motion home directory does not exist at all', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'home-worker-motion-perms-missing-'));
    try {
      const motionHome = join(tempDir, 'home', 'pi');

      expect(() =>
        runInstallFunction(tempDir, 'ensure_motion_video_storage_permissions', {
          HOME_WORKER_MOTION_HOME: motionHome,
        }),
      ).not.toThrow();
      expect(existsSync(motionHome)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('dispatches the experimental live-stream installer only for an explicit rtsp selection', () => {
    const script = readFileSync(resolve('scripts/install.sh'), 'utf8');
    expect(script).toContain("selected.includes('rtsp')");
    expect(script).toContain("n !== 'rtsp' || rtspSelected");
    expect(script).toContain('HOME_WORKER_PRIVILEGED=1 /usr/lib/home-worker/install-feature-routines');
    expect(script).toContain('/usr/lib/home-worker/feature-installer --verify-feature "$feature"');
  });

  it('instructs remote operators to reach the loopback-only setup wizard through SSH forwarding', () => {
    const script = readFileSync(resolve('scripts/install.sh'), 'utf8');

    expect(script).toContain('ssh -L 3000:127.0.0.1:3000');
    expect(script).toContain('http://127.0.0.1:3000');
    expect(script).not.toContain('http://$IP:3000');
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
          'export HOME_WORKER_INSTALL_LIBRARY=1',
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

  it('patches only live legacy serial commands, not comments or prior backups', () => {
    const script = readFileSync(resolve('scripts/install.sh'), 'utf8');
    const tempDir = mkdtempSync(join(tmpdir(), 'home-worker-serial-patch-'));

    try {
      const fakeBin = join(tempDir, 'bin');
      const installDir = join(tempDir, 'install');
      const scriptsDir = join(installDir, 'scripts');
      const installer = join(scriptsDir, 'install.sh');
      const legacyInstaller = join(scriptsDir, 'legacy-feature.sh');
      const priorBackup = `${legacyInstaller}.bak.serial.1`;

      execFileSync('mkdir', ['-p', fakeBin, scriptsDir]);
      writeFileSync(
        join(fakeBin, 'sudo'),
        '#!/bin/sh\nif [ "$1" = "-u" ]; then shift 2; fi\nexec "$@"\n',
      );
      chmodSync(join(fakeBin, 'sudo'), 0o755);
      writeFileSync(installer, script.replace(/\nmain "\$@"\s*$/, '\n'));
      writeFileSync(legacyInstaller, 'sudo raspi-config nonint do_serial 2\n');
      writeFileSync(priorBackup, 'sudo raspi-config nonint do_serial 2\n');

      const harness = join(tempDir, 'patch-legacy-serial.sh');
      writeFileSync(
        harness,
        [
          '#!/bin/bash',
          'set -euo pipefail',
          `export PATH=${shQuote(fakeBin)}:"$PATH"`,
          'export HOME_WORKER_INSTALL_LIBRARY=1',
          `export HOME_WORKER_INSTALL_DIR=${shQuote(installDir)}`,
          `. ${shQuote(installer)}`,
          'patch_legacy_feature_serial_calls',
          '',
        ].join('\n'),
      );
      chmodSync(harness, 0o755);

      execFileSync('bash', [harness]);

      expect(readFileSync(legacyInstaller, 'utf8')).toContain(
        'raspi-config nonint do_serial_hw 0 || true',
      );
      const generatedBackups = readdirSync(scriptsDir);
      expect(generatedBackups.filter((name) => name.startsWith('install.sh.bak.serial.'))).toHaveLength(
        0,
      );
      expect(
        generatedBackups.filter((name) =>
          name.startsWith('legacy-feature.sh.bak.serial.1.bak.serial.'),
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('continues when no legacy serial commands need patching', () => {
    const script = readFileSync(resolve('scripts/install.sh'), 'utf8');
    const tempDir = mkdtempSync(join(tmpdir(), 'home-worker-serial-noop-'));

    try {
      const fakeBin = join(tempDir, 'bin');
      const installDir = join(tempDir, 'install');
      const scriptsDir = join(installDir, 'scripts');
      const installer = join(scriptsDir, 'install.sh');

      execFileSync('mkdir', ['-p', fakeBin, scriptsDir]);
      writeFileSync(
        join(fakeBin, 'sudo'),
        '#!/bin/sh\nif [ "$1" = "-u" ]; then shift 2; fi\nexec "$@"\n',
      );
      chmodSync(join(fakeBin, 'sudo'), 0o755);
      writeFileSync(installer, script.replace(/\nmain "\$@"\s*$/, '\n'));

      const harness = join(tempDir, 'patch-legacy-serial-noop.sh');
      writeFileSync(
        harness,
        [
          '#!/bin/bash',
          'set -euo pipefail',
          `export PATH=${shQuote(fakeBin)}:"$PATH"`,
          'export HOME_WORKER_INSTALL_LIBRARY=1',
          `export HOME_WORKER_INSTALL_DIR=${shQuote(installDir)}`,
          `. ${shQuote(installer)}`,
          'patch_legacy_feature_serial_calls',
          '',
        ].join('\n'),
      );
      chmodSync(harness, 0o755);

      expect(() => execFileSync('bash', [harness], { encoding: 'utf8' })).not.toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
